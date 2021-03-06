#!/usr/bin/env node

require('./proof')(1, function (step, Strata, tmp, load, serialize, vivify, gather, assert) {
    var strata = new Strata({ directory: tmp, leafSize: 3, branchSize: 3 })
    step(function () {
        serialize(__dirname + '/fixtures/propagate.before.json', tmp, step())
    }, function () {
        strata.open(step())
    }, function () {
        strata.mutator('zz', step())
    }, function (cursor) {
        step(function () {
            cursor.insert('zz', 'zz', ~ cursor.index, step())
        }, function () {
            cursor.unlock(step())
        })
    }, function () {
        strata.balance(step())
    }, function () {
        vivify(tmp, step())
        load(__dirname + '/fixtures/propagate.after.json', step())
    }, function (actual, expected) {
        assert(actual, expected, 'split')
        strata.close(step())
    })
})
