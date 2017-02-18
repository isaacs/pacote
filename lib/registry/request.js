'use strict'

var cache = require('../cache')
var finished = require('mississippi').finished
var inflight = require('inflight')
var gunzip = require('../util/gunzip-maybe')
var pipe = require('mississippi').pipe
var registryKey = require('./registry-key')
var through = require('mississippi').through
var to = require('mississippi').to

module.exports = get
function get (uri, registry, opts, cb) {
  var key = cache.key('registry-request', uri)
  var memoed = cache.readMemoized(key)
  if (memoed) {
    console.log('!!! registry.get', key, 'already memoized!')
    return cb(null, memoed.data, memoed.raw)
  }
  cb = inflight(key, cb)
  if (!cb) {
    console.log('!!! registry.get', key, 'is already inflight')
    return
  }
  console.log('+++ registry.get make request', key, uri)
  var raw = ''
  var stream = getStream(uri, registry, opts)
  stream.on('end', function () {
    console.log('+++ registry.get stream end')
  })
  stream.on('finished', function () {
    console.log('+++ registry.get stream finished')
  })
  stream.on('closed', function () {
    console.log('+++ registry.get stream closed')
  })
  stream.on('data', function (d) { raw += d })
  stream.on('reset', function () { raw = '' })
  finished(stream, function (err) {
    console.log('<<< registry.get', err)
    if (err) { return cb(err) }
    try {
      var parsed = JSON.parse(raw)
      console.log('<<< parsed=', parsed)
    } catch (e) {
      return cb(e)
    }
    cache.memoize(key, {
      data: parsed,
      raw: raw
    })
    console.log('<<< registry.get', uri, parsed)
    return cb(null, parsed, raw)
  })
}

// Returns a stream of data from `uri` in `registry`.
//
// The stream emits the following events:
//
// * `data` - standard data event, representing the raw data
//          for `uri`.
// * `error` - final error state. No more data will be transferred.
// * `reset` - if this event is signaled, client must clear out any
//             state from previous `data` events, and continue
//             consuming from the same stream. This usually happens in the case
//             of network errors (where we might retry multiple times), or
//             in the case of cache staleness or error states.
//             If you need reliable, single-event output, use the non-stream
//             version of `get` instead.
// * `end` - emitted once, upon *successful* stream completion.
//
module.exports.stream = getStream
function getStream (uri, registry, opts) {
  var key = cache.key('registry-request', uri)
  var stream = opts.json ? through.obj() : through()

  if (!opts.cache) {
    console.log('registry.get', 'no cache option. skipping cache fetch')
    switchToRegistry(null, null)
  } else {
    console.log('registry.get', 'trying to grab from cache')
    var cs = cache.get.stream(opts.cache, key, opts)
    cs.on('metadata', function (meta) {
      if (isStale(meta, opts)) {
        console.log(
          'registry.get',
          'cache data for', key, 'stale. Checking registry.'
        )
        cs.pause()
        switchToRegistry(null, cs, meta)
      } else {
        console.log(
          'registry.get',
          'cached data for', key, 'valid. Reading from cache.'
        )
      }
    })
    cs.once('error', function (err) {
      if (err.code !== 'ENOENT') {
        console.log('registry.get', 'error while streaming from cache:', err)
      } else {
        console.log('registry.get', 'cache miss on', key)
      }
      switchToRegistry(err, null)
    })
    cs.pipe(stream)
    stream.on('error', function (e) { cs.emit('error', e) })
    stream.on('end', function () { cs.end() })
  }

  function switchToRegistry (err, fallback, meta) {
    if (opts.offline) {
      console.log(
        'registry.get',
        'offline mode enforced for',
        key
      )
      if (fallback) {
        console.log('registry.get', 'resuming stale cache stream for', key)
        fallback.resume()
      } else {
        if (!err) {
          err = new Error('no offline data available')
          err.code = 'ENOENT'
        }
        return stream.emit('error', err)
      }
    } else {
      if (fallback) {
        stream.emit('reset')
      }
      registryStream(
        key, uri, registry, meta, opts
      ).on('reset', function () {
        stream.emit('reset')
      }).on('cached', function () {
        console.log('registry.get', 'Got a 304. Switching back to cache.')
        fallback.resume()
      }).once('error', function (err) {
        console.log('registry.get', 'request error: ', err)
        if (!fallback) {
          stream.emit('error', err)
        } else {
          console.log('registry.get', 'using stale', key, 'from cache.')
          fallback.resume()
        }
      }).on('end', function () {
        stream.end()
      }).pipe(stream)
    }
  }

  return stream
}

function isStale (meta, opts) {
  if (!meta ||
    !meta.time ||
    (meta.cacheControl && meta.cacheControl.toLowerCase() === 'immutable') ||
    opts.preferOffline ||
    opts.offline) {
    console.log('registry.get', 'skipping staleness check for')
    return false
  } else {
    return ((new Date() - meta.time) / 1000) > opts.maxAge
  }
}

module.exports._registryStream = registryStream
function registryStream (key, uri, registry, meta, opts) {
  var stream = through()
  client(opts).get(uri, {
    etag: meta && meta.etag,
    lastModified: meta && meta.lastModified,
    follow: opts.follow,
    auth: opts.auth && opts.auth[registryKey(registry)],
    timeout: opts.timeout,
    streaming: true
  }, function (err, res) {
    if (err) { return stream.emit('error', err) }
    var decoder = res.headers['content-encoding'] === 'gzip'
    ? gunzip()
    : through()
    if (res.statusCode === 304) {
      console.log('registry.get', 'cached data valid')
      res.on('data', function () {}) // Just drain it
      stream.emit('cached')
      stream.unpipe()
      stream.end()
    } else if (opts.cache) {
      console.log('registry.get', 'request successful. streaming data to cache')
      var localopt = Object.create(opts)
      localopt.metadata = {
        etag: res.headers['etag'],
        lastModified: res.headers['last-modified'],
        cacheControl: res.headers['cache-conrol'],
        time: +(new Date())
      }
      var cacheStream = cache.put.stream(opts.cache, key, localopt)
      pipe(
        res,
        decoder,
        to(function (chunk, enc, cb) {
          cacheStream.write(chunk, enc, function () {
            stream.write(chunk, enc, cb)
          })
        }, function (cb) {
          cacheStream.end(function () {
            console.log('registry.get', 'wrapped up cacheStream')
            stream.end(cb)
          })
        }),
        function () {}
      )
    } else {
      console.log('registry.get', 'no cache. streaming straight out')
      pipe(res, decoder, stream, function () {})
    }
  })
  return stream
}

var CLIENT
var CLIENT_OPTS

function client (opts) {
  if (!CLIENT ||
      CLIENT_OPTS.log !== opts.log ||
      CLIENT_OPTS.retry !== opts.retry) {
    var RegistryClient = require('npm-registry-client')
    CLIENT_OPTS = {
      log: opts.log,
      retry: opts.retry
    }
    CLIENT = new RegistryClient(CLIENT_OPTS)
  }
  return CLIENT
}
