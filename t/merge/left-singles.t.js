#!/usr/bin/env node

require('./proof')(1, function (step, Strata, tmp, load, serialize, vivify, gather, assert) {
    var strata = new Strata({ directory: tmp, leafSize: 3, branchSize: 3 })
    step(function () {
        serialize(__dirname + '/fixtures/left-singles.before.json', tmp, step())
    }, function () {
        strata.open(step())
    }, function () {
        strata.mutator('bt', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('bt', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.indexOf('bu', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.unlock(step())
        })
    }, function () {
        strata.mutator('bw', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('bw', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.unlock(step())
        })
    }, function () {
        strata.balance(step())
    }, function () {
        vivify(tmp, step())
        load(__dirname + '/fixtures/left-singles.after.json', step())
    }, function (actual, expected) {
        assert(actual, expected, 'merged')
    }, function () {
        strata.close(step())
    })
})
