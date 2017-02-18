'use strict'

var optCheck = require('./lib/util/opt-check')
var rps = require('realize-package-specifier')

var handlers = {}

module.exports = manifest
function manifest (spec, opts, cb) {
  console.error('manifest fn', spec)
  if (!cb) {
    cb = opts
    opts = null
  }
  try {
    opts = optCheck(opts)
  } catch (er) {
    console.error('optcheck threw', er)
    throw er
  }

  console.error('checked opts', spec)
  rps(spec, function (err, res) {
    console.error('# rps cb', spec, err, res)
    if (err) { return cb(err) }
    var fetcher = handlers[res.type] || (handlers[res.type] = require('./lib/handlers/' + res.type + '/manifest'))
    fetcher(res, opts, function (err, mani) {
      console.error('# fetcher cb', spec, err, mani)
      cb(err, mani)
    })
  })
}
