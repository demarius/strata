#!/usr/bin/env node

Error.stackTraceLimit = Infinity

require('./proof')(3, function (step, Strata, tmp, load, serialize, vivify, gather, assert) {
    var strata = new Strata({ directory: tmp, leafSize: 3, branchSize: 3 })
    step(function () {
        serialize(__dirname + '/fixtures/branch.before.json', tmp, step())
    }, function () {
        strata.open(step())
    }, function () {
        strata.mutator('h', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('h', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.indexOf('i', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.unlock(step())
        })
    }, function () {
        strata.mutator('e', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('e', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.indexOf('g', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.unlock(step())
        })
    }, function () {
        strata.mutator('m', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('m', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.indexOf('n', step())
        }, function (index) {
            cursor.remove(index, step())
        }, function () {
            cursor.unlock(step())
        })
    }, function () {
        gather(strata, step())
    }, function (records) {
        assert(records, [ 'a', 'b', 'c', 'd',  'f', 'j', 'k', 'l' ], 'records')
        strata.balance(step())
    }, function () {
        strata.balance(step())
    }, function () {
        vivify(tmp, step())
        load(__dirname + '/fixtures/root-fill.after.json', step())
    }, function (actual, expected) {
        assert(actual, expected, 'merge')
    }, function () {
        gather(strata, step())
    }, function (records) {
        assert(records, [ 'a', 'b', 'c', 'd', 'f', 'j', 'k', 'l' ], 'merged')
    }, function() {
        strata.close(step())
    })
})
