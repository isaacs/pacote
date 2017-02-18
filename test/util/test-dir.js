'use strict'

var mkdirp = require('mkdirp')
var path = require('path')
var rimraf = require('rimraf')
var tap = require('tap')

var cacheDir = path.resolve(__dirname, '../cache')

module.exports = testDir
function testDir (filename) {
  var base = path.basename(filename, '.js')
  var dir = path.join(cacheDir, base)
  reset(dir)
  if (!process.env.KEEPCACHE) {
    tap.tearDown(function () {
      process.chdir(__dirname)
      try {
        rimraf.sync(dir)
      } catch (e) {
        if (process.platform !== 'win32') {
          throw e
        } else {
          console.log('testDir error on windows', e)
        }
      }
    })
    tap.afterEach(function (cb) {
      reset(dir)
      cb()
    })
  }
  return dir
}

module.exports.reset = reset
function reset (testDir) {
  console.log('~~~ test/utils/testdir.reset', testDir)
  process.chdir(__dirname)
  try {
    rimraf.sync(testDir)
  } catch (e) {
    if (process.platform !== 'win32') {
      throw e
    } else {
      console.log('resetdir error on windows', e)
    }
  }
  mkdirp.sync(testDir)
  process.chdir(testDir)
}
