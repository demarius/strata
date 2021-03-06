#!/usr/bin/env node

require('./proof')(4, function (step, Strata, tmp, serialize, gather, assert) {
    var strata = new Strata({ directory: tmp, leafSize: 3, branchSize: 3 })
    step(function () {
        serialize(__dirname + '/fixtures/ambiguous.before.json', tmp, step())
    }, function () {
        strata.open(step())
    }, function () {
        gather(strata, step())
    }, function (records) {
        assert(records, [ 'a', 'd', 'f', 'g', 'h', 'i', 'l', 'm', 'n' ], 'records')
    }, function () {
        strata.mutator('a', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('b', step())
        }, function (index) {
            assert(~index <= cursor.length, 'unambiguous')
            cursor.insert('b', 'b', ~index, step())
        }, function () {
            cursor.indexOf('c', step())
        }, function (index) {
            assert(~index <= cursor.length, 'unambiguous cached')
            cursor.insert('c', 'c', ~index, step())
        }, function (unambiguous) {
            cursor.unlock(step())
        }, function () {
            gather(strata, step())
        })
    }, function (records) {
        assert(records, [ 'a', 'b', 'c', 'd', 'f', 'g', 'h', 'i', 'l', 'm', 'n' ], 'records')
    }, function() {
        strata.close(step())
    })
})
