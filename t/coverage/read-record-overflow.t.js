#!/usr/bin/env node

require('./proof')(1, function (step, Strata, tmp, serialize, gather, assert) {
    var strata = new Strata({
        directory: tmp,
        branchSize: 3,
        leafSize: 3,
        readRecordStartLength: 2
    })
    step(function () {
        serialize(__dirname + '/fixtures/read-record.before.json', tmp, step())
    }, function () {
        strata.open(step())
    }, function () {
        gather(strata, step())
    }, function (records) {
        assert(records, [ 'a', 'c', 'd' ], 'records')
    }, function () {
        strata.close(step())
    })
})
