'use strict'

var checksumStream = require('./util/checksum-stream')
var dezalgo = require('dezalgo')
var finished = require('mississippi').finished
var gunzip = require('./util/gunzip-maybe')
var minimatch = require('minimatch')
var normalize = require('normalize-package-data')
var optCheck = require('./util/opt-check')
var path = require('path')
var pipe = require('mississippi').pipe
var pipeline = require('mississippi').pipeline
var tar = require('tar-stream')
var through = require('mississippi').through

module.exports = finalizeManifest
function finalizeManifest (pkg, spec, where, opts, cb) {
  completeFromTarball(pkg, spec, where, opts, function (err) {
    if (err) { return cb(err) }
    // normalize should not add any fields, and once
    // makeManifest completes, it should never be modified.
    cb(null, new Manifest(pkg))
  })
}

module.exports.Manifest = Manifest
function Manifest (pkg) {
  this.name = pkg.name
  this.version = pkg.version
  this.dependencies = pkg.dependencies || {}
  this.optionalDependencies = pkg.optionalDependencies || {}
  this.devDependencies = pkg.devDependencies || {}
  var bundled = (
    pkg.bundledDependencies ||
    pkg.bundleDependencies ||
    false
  )
  this.bundleDependencies = !!bundled.length || false
  this.peerDependencies = pkg.peerDependencies || {}

  // This one depends entirely on each handler.
  this._resolved = pkg._resolved

  // Filled in by completeFromTarball as needed.
  this._shasum = pkg._shasum
  this._shrinkwrap = pkg._shrinkwrap || null
  this.bin = pkg.bin || null

  this._id = null // filled in by normalize-package-data, but unnecessary

  Object.preventExtensions(this)
  normalize(this)
  Object.freeze(this)
}

// Some things aren't filled in by standard manifest fetching.
// If this function needs to do its work, it will grab the
// package tarball, extract it, and take whatever it needs
// from the stream.
function completeFromTarball (pkg, spec, where, opts, cb) {
  cb = dezalgo(cb)
  var needsShrinkwrap = !(
    pkg._hasShrinkwrap === false ||
    pkg._shrinkwrap
  )
  var needsBin = !!(
    !pkg.bin &&
    pkg.directories &&
    pkg.directories.bin
  )
  var needsShasum = !pkg._shasum
  if (!needsShrinkwrap && !needsBin && !needsShasum) {
    opts.log.silly('finalize-manifest', 'Skipping tarball extraction -- nothing needed.')
    return cb(null)
  } else {
    opts = optCheck(opts)
    opts.memoize = false
    var tarball = require('./handlers/' + spec.type + '/tarball')
    var tarData = tarball.fromManifest(pkg, spec, opts)
    var shaStream = null
    var extractorStream = null

    if (needsShrinkwrap || needsBin) {
      opts.log.silly('finalize-manifest', 'parsing tarball for', spec.name)
      var dirBin = pkg.directories && pkg.directories.bin
      pkg.bin = pkg.bin || {}
      var dataStream = tar.extract()
      extractorStream = pipeline(gunzip(), dataStream)
      dataStream.on('entry', function doEntry (header, fileStream, next) {
        var filePath = header.name.replace(/[^/]+\//, '')
        if (needsShrinkwrap && filePath === 'npm-shrinkwrap.json') {
          var srData = ''
          fileStream.on('data', function (d) { srData += d })

          return finished(fileStream, function (err) {
            if (err) { return dataStream.emit('error', err) }
            try {
              pkg._shrinkwrap = JSON.parse(srData)
              next()
            } catch (e) {
              dataStream.emit('error', e)
            }
          })
        } else if (needsBin && minimatch(filePath, dirBin + '/**')) {
          var relative = path.relative(dirBin, filePath)
          if (relative && relative[0] !== '.') {
            pkg.bin[path.basename(relative)] = path.join(dirBin, relative)
          }
        }
        // Drain and get next one
        fileStream.on('data', function () {})
        next()
      })
    } else {
      extractorStream = through()
    }
    if (needsShasum) {
      shaStream = checksumStream(null, opts.hashAlgorithm)
      shaStream.on('digest', function (d) {
        pkg._shasum = d
      })
    } else {
      shaStream = through()
    }
    // Drain the end stream
    extractorStream.on('data', function () {})
    return pipe(tarData, shaStream, extractorStream, cb)
  }
}
