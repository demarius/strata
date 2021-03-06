#!/usr/bin/env node

require('./proof')(3, function (step, Strata, tmp, load, serialize, vivify, gather, assert, say) {
    var strata
    step(function () {
        serialize(__dirname + '/fixtures/merge.before.json', tmp, step())
    }, function () {
        strata = new Strata({ directory: tmp, leafSize: 3, branchSize: 3 })
        strata.open(step())
    }, function () {
        strata.mutator('b', step())
    }, function (cursor) {
        step(function () {
            cursor.remove(cursor.index, step())
        }, function () {
            cursor.unlock(step())
        }, function () {
            gather(strata, step())
        })
    }, function (records) {
        step(function () {
            assert(records, [ 'a', 'c', 'd' ], 'records')
            strata.balance(step())
        }, function () {
            vivify(tmp, step())
            load(__dirname + '/fixtures/merge.after.json', step())
        }, function (actual, expected) {
            say(expected)
            say(actual)

            assert(actual, expected, 'merge')
        }, function () {
            gather(strata, step())
        }, function (records) {
            assert(records, [ 'a', 'c', 'd' ], 'records')
            strata.balance(step())
        })
    })
})
