'use strict'

var optCheck = require('./lib/util/opt-check')
var rps = require('realize-package-specifier')

var handlers = {}

module.exports = manifest
function manifest (spec, opts, cb) {
  if (!cb) {
    cb = opts
    opts = null
  }
  opts = optCheck(opts)

  rps(spec, function (err, res) {
    console.log('rps cb', err, res)
    if (err) { return cb(err) }
    if (!handlers[res.type]) {
      handlers[res.type] = require('./lib/handlers/' + res.type + '/manifest')
    }
    var fetcher = handlers[res.type]
    console.log('>>>fetcher', res.type)
    fetcher(res, opts, function (err, mani) {
      console.log('<<<fetcher', res.type, err, mani)
      cb(err, mani)
    })
  })
}
