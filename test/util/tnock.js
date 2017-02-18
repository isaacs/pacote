'use strict'

var nock = require('nock')
var clearMemoized = require('../../lib/cache')._clearMemoized

module.exports = tnock
function tnock (t, host) {
  clearMemoized()
  var stack = new Error().stack.split('\n').slice(1).join('\n')
  var server = nock(host)
  t.tearDown(function () {
    var threw = true
    try {
      server.done()
    } catch (er) {
      console.error('failed tnock\n%s', stack, t, er)
      throw er
    }
  })
  return server
}
