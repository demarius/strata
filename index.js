var Cache = require('magazine'),
    Journalist = require('journalist'),
    cadence = require('cadence'),
    ok = require('assert').ok,
    path = require('path')

// todo: temporary
var scram = require('./scram')

function extend(to, from) {
    for (var key in from) to[key] = from[key]
    return to
}

var __slice = [].slice

/*function say() {
        var args = __slice.call(arguments)
        console.log(require('util').inspect(args, false, null))
}*/

function compare (a, b) { return a < b ? -1 : a > b ? 1 : 0 }

function extract (a) { return a }

function Locker (sheaf, magazine) {
    ok(arguments.length, 'no arguments')
    ok(magazine)
    this._locks = {}
    this._sheaf = sheaf
    this._magazine = magazine
}

Locker.prototype.lock = cadence(function (step, address, exclusive) {
    var cartridge = this._magazine.hold(address, {}),
        page = cartridge.value.page,
        locked

    ok(!this._locks[address], 'address already locked by this locker')

    if (!page)  {
        if (address % 2) {
            page = this._sheaf.createLeaf({ address: address })
        } else {
            page = this._sheaf.createBranch({ address: address })
        }
        cartridge.value.page = page
        var loaded = function (error) {
            if (error) {
                cartridge.value.page = null
                cartridge.adjustHeft(-cartridge.heft)
            }
            this._locks[page.address].unlock(error, page)
        }.bind(this)
        this._locks[page.address] = page.queue.createLock()
        this._locks[page.address].exclude(function () {
            if (page.address % 2) {
                this._sheaf.readLeaf(page, loaded)
            } else {
                this._sheaf.readBranch(page, loaded)
            }
        }.bind(this))
    } else {
        this._locks[page.address] = page.queue.createLock()
    }

    step([function () {
        step(function () {
            this._locks[page.address][exclusive ? 'exclude' : 'share'](step())
        },
        function () {
            this._sheaf.tracer('lock', { address: address, exclusive: exclusive }, step())
        }, function () {
            locked = true
            return [ page ]
        })
    }, function (errors, error) {
        // todo: if you don't return something, then the return is the
        // error, but what else could it be? Document that behavior, or
        // set a reasonable default.
        this._magazine.get(page.address).release()
        this._locks[page.address].unlock(error)
        delete this._locks[page.address]
        throw errors
    }])
})

Locker.prototype.encache = function (page) {
    this._magazine.hold(page.address, { page: page })
    this._locks[page.address] = page.queue.createLock()
    this._locks[page.address].exclude(function () {})
    return page
}

Locker.prototype.checkCacheSize = function (page) {
    var size = 0, position
    if (page.address != -2) {
        if (page.address % 2) {
            if (page.positions.length) {
                size += JSON.stringify(page.positions).length
                size += JSON.stringify(page.lengths).length
            }
        } else {
            if (page.addresses.length) {
                size += JSON.stringify(page.addresses).length
            }
        }
        for (position in page.cache) {
            size += page.cache[position].size
        }
    }
    ok(size == this._magazine.get(page.address).heft, 'sizes are wrong')
}

Locker.prototype.unlock = function (page) {
    this.checkCacheSize(page)
    this._locks[page.address].unlock(null, page)
    if (!this._locks[page.address].count) {
        delete this._locks[page.address]
    }
    this._magazine.get(page.address).release()
}

Locker.prototype.increment = function (page) {
    this._locks[page.address].increment()
    this._magazine.hold(page.address)
}

Locker.prototype.dispose = function () {
    ok(!Object.keys(this._locks).length, 'locks outstanding')
    this._locks = null
}

function Cursor (sheaf, journal, descents, exclusive, searchKey) {
    this._journal = journal
    this._sheaf = sheaf
    this._locker = descents[0].locker
    this._page = descents[0].page
    this._rightLeafKey = null
    this._searchKey = searchKey
    this.exclusive = exclusive
    this.index = descents[0].index
    this.offset = this.index < 0 ? ~ this.index : this.index

    descents.shift()
}

// to user land
Cursor.prototype.get = cadence(function (step, index) {
    step(function () {
        this._sheaf.stash(this._page, index, step())
    }, function (entry, size) {
        return [ entry.record, entry.key, size ]
    })
})

// to user land
Cursor.prototype.next = cadence(function (step) {
    var next
    this._rightLeafKey = null

    if (!this._page.right) {
        // return [ step, false ] <- return immediately!
        return [ false ]
    }

    step(function () {
        this._locker.lock(this._page.right, this.exclusive, step())
    }, function (next) {
        this._locker.unlock(this._page)

        this._page = next

        this.offset = this._page.ghosts
        this.length = this._page.positions.length

        return [ true ]
    })
})

// to user land
Cursor.prototype.indexOf = cadence(function (step, key) {
    step(function () {
        this._sheaf._find(this._page, key, this._page.ghosts, step())
    }, function (index) {
        var unambiguous
        unambiguous = -1 < index
                   || ~ index < this._page.positions.length
                   || ! this._page.right
                   || this._searchKey.length && this._sheaf.comparator(this._searchKey[0], key) == 0
        if (!unambiguous) step(function () {
            if (!this._rightLeafKey) step(function () {
                this._locker.lock(this._page.right, false, step())
            }, function (rightLeafPage) {
                step(function () {
                    this._sheaf.stash(rightLeafPage, 0, step())
                }, [function () {
                    this._locker.unlock(rightLeafPage)
                }], function (entry) {
                    this._rightLeafKey = entry.key
                })
            })
        }, function  () {
            if (this._sheaf.comparator(key, this._rightLeafKey) >= 0) {
                return [ ~(this._page.positions.length + 1) ]
            } else {
                return index
            }
        })
    })
})

// todo: pass an integer as the first argument to force the arity of the
// return.
Cursor.prototype._unlock = cadence(function (step) {
    step([function () {
        this._locker.unlock(this._page)
        this._locker.dispose()
    }], function () {
        this._journal.close('leaf', step(0))
    })
})

Cursor.prototype.unlock = function (callback) {
    ok(callback, 'unlock now requires a callback')
    this._unlock(callback)
}

// note: exclusive, index, offset and length are public

Cursor.prototype.__defineGetter__('address', function () {
    return this._page.address
})

Cursor.prototype.__defineGetter__('right', function () {
    return this._page.right
})

Cursor.prototype.__defineGetter__('ghosts', function () {
    return this._page.ghosts
})

Cursor.prototype.__defineGetter__('length', function () {
    return this._page.positions.length
})

Cursor.prototype.insert = cadence(function (step, record, key, index) {
    ok(this.exclusive, 'cursor is not exclusive')
    ok(index > 0 || this._page.address == 1)

    var entry
    this._sheaf.unbalanced(this._page)
    step(function () {
        entry = this._journal.open(this._sheaf.filename(this._page.address), this._page.position, this._page)
        this._sheaf.journalist.purge(step())
    }, function () {
        entry.ready(step())
    }, function () {
        scram.call(this, entry, cadence(function (step) {
            step(function () {
                this._sheaf.writeInsert(entry, this._page, index, record, step())
            }, function (position, length, size) {
                this._sheaf.splice('positions', this._page, index, 0, position)
                this._sheaf.splice('lengths', this._page, index, 0, length)
                this._sheaf._cacheRecord(this._page, position, record, size)
                this.length = this._page.positions.length
            }, function () {
                step(function () {
                    entry.close('entry', step())
                }, function () {
                    return []
                })
            })
        }), step())
    })
})

Cursor.prototype.remove = cadence(function (step, index) {
    var ghost = this._page.address != 1 && index == 0, entry
    this._sheaf.unbalanced(this._page)
    step(function () {
        this._sheaf.journalist.purge(step())
    }, function () {
        entry = this._journal.open(this._sheaf.filename(this._page.address), this._page.position, this._page)
        entry.ready(step())
    }, function () {
        scram.call(this, entry, cadence(function (step) {
            step(function () {
                this._sheaf.writeDelete(entry, this._page, index, step())
            }, function () {
                if (ghost) {
                    this._page.ghosts++
                    this.offset || this.offset++
                } else {
                    this._sheaf.uncacheEntry(this._page, this._page.positions[index])
                    this._sheaf.splice('positions', this._page, index, 1)
                    this._sheaf.splice('lengths', this._page, index, 1)
                }
            }, function () {
                entry.close('entry', step())
            })
        }), step())
    }, function () {
        // todo: arity in delclaration.
        return []
    })
})

function Descent (sheaf, locker, override) {
    ok(locker instanceof Locker)

    override = override || {}

    this. exclusive = override.exclusive || false
    this.depth = override.depth == null ? -1 : override.depth
    this.indexes = override.indexes || {}
    this.sheaf = sheaf
    this.greater = override.greater
    this.lesser = override.lesser
    this.page = override.page
    this._index = override.index == null ? 0 : override.index
    this.locker = locker
    this.descent = {}

    if (!this.page) {
        this.locker.lock(-2, false, function (error, page) {
            ok(!error, 'impossible error')
            this.page = page
        }.bind(this))
        ok(this.page, 'dummy page not in cache')
    } else {
        this.locker.increment(this.page)
    }
}

Descent.prototype.__defineSetter__('index', function (i) {
    this.indexes[this.page.address] = this._index = i
})

Descent.prototype.__defineGetter__('index', function () {
    return this._index
})

Descent.prototype.fork = function () {
    return new Descent(this.sheaf, this.locker, {
        page: this.page,
        exclusive: this.exclusive,
        depth: this.depth,
        index: this.index,
        indexes: extend({}, this.indexes)
    })
}

Descent.prototype.exclude = function () {
    this.exclusive = true
}

Descent.prototype.upgrade = cadence(function (step) {
    step([function () {
        this.locker.unlock(this.page)
        this.locker.lock(this.page.address, this.exclusive = true, step())
    }, function (errors) {
        this.locker.lock(-2, false, function (error, locked) {
            ok(!error, 'impossible error')
            this.page = locked
        }.bind(this))
        ok(this.page, 'dummy page not in cache')
        throw errors
    }], function (locked) {
        this.page = locked
    })
})

Descent.prototype.key = function (key) {
    return function (callback) {
        return this.sheaf._find(this.page, key, this.page.address % 2 ? this.page.ghosts : 1, callback)
    }
}

Descent.prototype.left = function (callback) { callback(null, this.page.ghosts || 0) }

Descent.prototype.right = function (callback) { callback(null, (this.page.addresses || this.page.positions).length - 1) }

Descent.prototype.found = function (keys) {
    return function () {
        return this.page.addresses[0] != 0 && this.index != 0 && keys.some(function (key) {
            return this.sheaf.comparator(this.page.cache[this.page.addresses[this.index]].key,  key) == 0
        }, this)
    }
}

Descent.prototype.child = function (address) { return function () { return this.page.addresses[this.index] == address } }

Descent.prototype.address = function (address) { return function () { return this.page.address == address } }

Descent.prototype.penultimate = function () { return this.page.addresses[0] % 2 }

Descent.prototype.leaf = function () { return this.page.address % 2 }

Descent.prototype.level = function (level) {
    return function () { return level == this.depth }
}

Descent.prototype.unlocker = function (parent) {
    this.locker.unlock(parent)
}

Descent.prototype.descend = cadence(function (step, next, stop) {
    var above = this.page

    var loop = step(function () {
        if (stop.call(this)) {
            return [ loop, this.page, this.index ]
        } else {
            if (this.index + 1 < this.page.addresses.length) {
                this.greater = this.page.address
            }
            if (this.index > 0) {
                this.lesser = this.page.address
            }
            this.locker.lock(this.page.addresses[this.index], this.exclusive, step())
        }
    }, function (locked) {
        this.depth++
        this.unlocker(this.page, locked)
        this.page = locked
        next.call(this, step())
    }, function (index) {
        if (!(this.page.address % 2) && index < 0) {
            this.index = (~index) - 1
        } else {
            this.index = index
        }
        this.indexes[this.page.address] = this.index
        if (!(this.page.address % 2)) {
            ok(this.page.addresses.length, 'page has addresses')
            ok(this.page.cache[this.page.addresses[0]] == (void(0)), 'first key is cached')
        }
    })()
})

Sheaf.prototype.unbalanced = function (page, force) {
    if (force) {
        this.lengths[page.address] = this.options.leafSize
    } else if (this.lengths[page.address] == null) {
        this.lengths[page.address] = page.positions.length - page.ghosts
    }
}

Sheaf.prototype._nodify = cadence(function (step, locker, page) {
    step(function () {
        step([function () {
            locker.unlock(page)
        }], function () {
            ok(page.address % 2, 'leaf page expected')

            if (page.address == 1) return [{}]
            else this.stash(page, 0, step())
        }, function (entry) {
            var node = {
                key: entry.key,
                address: page.address,
                rightAddress: page.right,
                length: page.positions.length - page.ghosts
            }
            this.ordered[node.address] = node
            if (page.ghosts) {
                this.ghosts[node.address] = node
            }
            return [ node ]
        })
    }, function (node) {
        step(function () {
            this.tracer('reference', {}, step())
        }, function () {
            return node
        })
    })
})

// to user land
Sheaf.prototype.balance = cadence(function balance (step) {
    var locker = this.createLocker(), operations = [], address, length

    var _gather = cadence(function (step, address, length) {
        var right, node
        step(function () {
            if (node = this.ordered[address]) {
                return [ node ]
            } else {
                step(function () {
                    locker.lock(address, false, step())
                }, function (page) {
                    this._nodify(locker, page, step())
                })
            }
        }, function (node) {
            if (!(node.length - length < 0)) return
            if (node.address != 1 && ! node.left) step(function () {
                var descent = new Descent(this, locker)
                step(function () {
                    descent.descend(descent.key(node.key), descent.found([node.key]), step())
                }, function () {
                    descent.index--
                    descent.descend(descent.right, descent.leaf, step())
                }, function () {
                    var left
                    if (left = this.ordered[descent.page.address]) {
                        locker.unlock(descent.page)
                        return [ left ]
                    } else {
                        this._nodify(locker, descent.page, step())
                    }
                }, function (left) {
                    left.right = node
                    node.left = left
                })
            })
            if (!node.right && node.rightAddress) step(function () {
                if (right = this.ordered[node.rightAddress]) return [ right ]
                else step(function () {
                    locker.lock(node.rightAddress, false, step())
                }, function (page) {
                    this._nodify(locker, page, step())
                })
            }, function (right) {
                node.right = right
                right.left = node
            })
        })
    })

    ok(!this.balancing, 'already balancing')

    var lengths = this.lengths, addresses = Object.keys(lengths)
    if (addresses.length == 0) {
        return [ step, true ]
    } else {
        this.lengths = {}
        this.operations = []
        this.ordered = {}
        this.ghosts = {}
        this.balancing = true
    }

    step(function () {
        step(function (address) {
            _gather.call(this, +address, lengths[address], step())
        })(addresses)
    }, function () {
        this.tracer('plan', {}, step())
    }, function () {
        var address, node, difference, addresses

        for (address in this.ordered) {
            node = this.ordered[address]
        }

        function terminate (node) {
            var right
            if (node) {
                if (right = node.right) {
                    node.right = null
                    right.left = null
                }
            }
            return right
        }

        function unlink (node) {
            terminate(node.left)
            terminate(node)
            return node
        }

        for (address in lengths) {
            length = lengths[address]
            node = this.ordered[address]
            difference = node.length - length
            if (difference > 0 && node.length > this.options.leafSize) {
                operations.unshift({
                    method: 'splitLeaf',
                    parameters: [ node.address, node.key, this.ghosts[node.address] ]
                })
                delete this.ghosts[node.address]
                unlink(node)
            }
        }

        for (address in this.ordered) {
            if (this.ordered[address].left) delete this.ordered[address]
        }

        for (address in this.ordered) {
            var node = this.ordered[address]
            while (node && node.right) {
                if (node.length + node.right.length > this.options.leafSize) {
                    node = terminate(node)
                    this.ordered[node.address] = node
                } else {
                    if (node = terminate(node.right)) {
                        this.ordered[node.address] = node
                    }
                }
            }
        }

        for (address in this.ordered) {
            node = this.ordered[address]

            if (node.right) {
                ok(!node.right.right, 'merge pair still linked to sibling')
                operations.unshift({
                    method: 'mergeLeaves',
                    parameters: [ node.right.key, node.key, lengths, !!this.ghosts[node.address] ]
                })
                delete this.ghosts[node.address]
                delete this.ghosts[node.right.address]
            }
        }

        for (address in this.ghosts) {
            node = this.ghosts[address]
            if (node.length) operations.unshift({
                method: 'deleteGhost',
                parameters: [ node.key ]
            })
        }

        step(function () {
            step(function (operation) {
                this[operation.method].apply(this, operation.parameters.concat(step()))
            })(operations)
        }, function () {
            this.balancing = false
            return false
        })
    })
})

Sheaf.prototype.shouldSplitBranch = function (branch, key, callback) {
    if (branch.addresses.length > this.options.branchSize) {
        if (branch.address == 0) {
            this.drainRoot(callback)
        } else {
            this.splitBranch(branch.address, key, callback)
        }
    } else {
        callback(null)
    }
}

Sheaf.prototype.splitLeaf = cadence(function (step, address, key, ghosts) {
    var locker = this.createLocker(),
        descents = [], replacements = [], encached = [],
        completed = 0,
        penultimate, leaf, split, pages, page,
        records, remainder, right, index, offset, length

    step(function () {
        step([function () {
            encached.forEach(function (page) { locker.unlock(page) })
            descents.forEach(function (descent) { locker.unlock(descent.page) })
            locker.dispose()
        }], function () {
            if (address != 1 && ghosts) step(function () {
                this.deleteGhost(key, step())
            }, function (rekey) {
                key = rekey
            })
        }, function () {
            descents.push(penultimate = new Descent(this, locker))

            penultimate.descend(address == 1 ? penultimate.left : penultimate.key(key),
                                penultimate.penultimate, step())
        }, function () {
            penultimate.upgrade(step())
        }, function () {
            descents.push(leaf = penultimate.fork())
            leaf.descend(address == 1 ? leaf.left : leaf.key(key), leaf.leaf, step())
        }, function () {
            split = leaf.page
            if (split.positions.length - split.ghosts <= this.options.leafSize) {
                this.unbalanced(split, true)
                return [ step ]
            }
        }, function () {
            pages = Math.ceil(split.positions.length / this.options.leafSize)
            records = Math.floor(split.positions.length / pages)
            remainder = split.positions.length % pages

            right = split.right

            offset = split.positions.length

            step(function () {
                page = locker.encache(this.createLeaf({ loaded: true }))
                encached.push(page)

                page.right = right
                right = page.address

                this.splice('addresses', penultimate.page, penultimate.index + 1, 0, page.address)

                length = remainder-- > 0 ? records + 1 : records
                offset = split.positions.length - length
                index = offset


                step(function () {
                    var position = split.positions[index]

                    ok(index < split.positions.length)

                    step(function () {
                        this.stash(split, index, step())
                    }, function (entry) {
                        this.uncacheEntry(split, position)
                        this.splice('positions', page, page.positions.length, 0, position)
                        this.splice('lengths', page, page.lengths.length, 0, split.lengths[index])
                        this.encacheEntry(page, position, entry)
                        index++
                    })
                })(length)
            }, function () {
                this.splice('positions', split, offset, length)
                this.splice('lengths', split, offset, length)

                var entry = page.cache[page.positions[0]]

                this.encacheKey(penultimate.page, page.address, entry.key, entry.keySize)

                replacements.push(page)

                this.rewriteLeaf(page, '.replace', step())
            })(pages - 1)
        }, function () {
            split.right = right

            replacements.push(split)

            this.rewriteLeaf(split, '.replace', step())
        }, function () {
            this.writeBranch(penultimate.page, '.pending', step())
        }, function () {
            this.tracer('splitLeafCommit', {}, step())
        }, function () {
            this.rename(penultimate.page, '.pending', '.commit', step())
        }, function () {
            step(function (page) {
                this.replace(page, '.replace', step())
            })(replacements)
        }, function () {
            this.replace(penultimate.page, '.commit', step())
        }, function () {
            this.unbalanced(leaf.page, true)
            this.unbalanced(page, true)
            return [ encached[0].cache[encached[0].positions[0]].key ]
        })
    }, function (partition) {
        this.shouldSplitBranch(penultimate.page, partition, step())
    })
})

Sheaf.prototype.splitBranch = cadence(function (step, address, key) {
    var locker = this.createLocker(),
        descents = [],
        children = [],
        encached = [],
        parent, full, split, pages,
        records, remainder, offset,
        unwritten, pending

    step(function () {
        step([function () {
            encached.forEach(function (page) { locker.unlock(page) })
            descents.forEach(function (descent) { locker.unlock(descent.page) })
            locker.dispose()
        }], function () {
            descents.push(parent = new Descent(this, locker))
            parent.descend(parent.key(key), parent.child(address), step())
        }, function () {
            parent.upgrade(step())
        }, function () {
            descents.push(full = parent.fork())
            full.descend(full.key(key), full.level(full.depth + 1), step())
        }, function () {
            split = full.page

            pages = Math.ceil(split.addresses.length / this.options.branchSize)
            records = Math.floor(split.addresses.length / pages)
            remainder = split.addresses.length % pages

            offset = split.addresses.length

            for (var i = 0; i < pages - 1; i++ ) {
                var page = locker.encache(this.createBranch({}))

                children.push(page)
                encached.push(page)

                var length = remainder-- > 0 ? records + 1 : records
                var offset = split.addresses.length - length

                var cut = this.splice('addresses', split, offset, length)

                this.splice('addresses', parent.page, parent.index + 1, 0, page.address)

                this.encacheEntry(parent.page, page.address, split.cache[cut[0]])

                var keys = {}
                cut.forEach(function (address) {
                    keys[address] = this.uncacheEntry(split, address)
                }, this)

                this.splice('addresses', page, 0, 0, cut)

                cut.slice(1).forEach(function (address) {
                    this.encacheEntry(page, address, keys[address])
                }, this)
            }
        }, function () {
            children.unshift(full.page)
            step(function (page) {
                this.writeBranch(page, '.replace', step())
            })(children)
        }, function () {
            this.writeBranch(parent.page, '.pending', step())
        }, function () {
            this.rename(parent.page, '.pending', '.commit', step())
        }, function () {
            step(function (page) {
                this.replace(page, '.replace', step())
            })(children)
        }, function () {
            this.replace(parent.page, '.commit', step())
        })
    }, function () {
        this.shouldSplitBranch(parent.page, key, step())
    })
})

Sheaf.prototype.drainRoot = cadence(function (step) {
    var locker = this.createLocker(),
        keys = {}, children = [], locks = [],
        root, pages, records, remainder

    step(function () {
        step([function () {
            children.forEach(function (page) { locker.unlock(page) })
            locks.forEach(function (page) { locker.unlock(root) })
            locker.dispose()
        }], function () {
            locker.lock(0, true, step())
        }, function (locked) {
            locks.push(root = locked)
            pages = Math.ceil(root.addresses.length / this.options.branchSize)
            records = Math.floor(root.addresses.length / pages)
            remainder = root.addresses.length % pages

            for (var i = 0; i < pages; i++) {
                var page = locker.encache(this.createBranch({}))

                children.push(page)

                var length = remainder-- > 0 ? records + 1 : records
                var offset = root.addresses.length - length

                var cut = this.splice('addresses', root, offset, length)

                cut.slice(offset ? 0 : 1).forEach(function (address) {
                    keys[address] = this.uncacheEntry(root, address)
                }, this)

                this.splice('addresses', page, 0, 0, cut)

                cut.slice(1).forEach(function (address) {
                    this.encacheEntry(page, address, keys[address])
                }, this)

                keys[page.address] = keys[cut[0]]
            }

            children.reverse()

            this.splice('addresses', root, 0, 0, children.map(function (page) { return page.address }))

            root.addresses.slice(1).forEach(function (address) {
                this.encacheEntry(root, address, keys[address])
            }, this)
        }, function () {
            step(function (page) {
                this.writeBranch(page, '.replace', step())
            })(children)
        }, function () {
            this.writeBranch(root, '.pending', step())
        }, function () {
            this.rename(root, '.pending', '.commit', step())
        }, function () {
            step(function (page) {
                this.replace(page, '.replace', step())
            })(children)
        }, function () {
            this.replace(root, '.commit', step())
        })
    }, function () {
        if (root.addresses.length > this.options.branchSize) this.drainRoot(step())
    })
})

Sheaf.prototype.exorcise = cadence(function (step, pivot, page, corporal) {
    var entry

    ok(page.ghosts, 'no ghosts')
    ok(corporal.positions.length - corporal.ghosts > 0, 'no replacement')

    this.uncacheEntry(page, this.splice('positions', page, 0, 1).shift())
    this.splice('lengths', page, 0, 1)
    page.ghosts = 0

    step(function () {
        entry = this.journal.leaf.open(this.filename(page.address), page.position, page)
        entry.ready(step())
    }, function () {
        this.writePositions(entry, page, step())
    }, function () {
    // todo: close on failure.
        entry.close('entry', step())
    }, function () {
        this.stash(corporal, corporal.ghosts, step())
    }, function (entry) {
        this.uncacheEntry(pivot.page, pivot.page.addresses[pivot.index])
        this.encacheKey(pivot.page, pivot.page.addresses[pivot.index], entry.key, entry.keySize)
        return [ page.key = entry.key ]
    })
})

Sheaf.prototype.deleteGhost = cadence(function (step, key) {
    var locker = this.createLocker(),
        descents = [],
        pivot, leaf, fd
    step([function () {
        descents.forEach(function (descent) { locker.unlock(descent.page) })
        locker.dispose()
    }], function () {
        descents.push(pivot = new Descent(this, locker))
        pivot.descend(pivot.key(key), pivot.found([key]), step())
    }, function () {
        pivot.upgrade(step())
    }, function () {
        descents.push(leaf = pivot.fork())

        leaf.descend(leaf.key(key), leaf.leaf, step())
    }, function () {
        this.exorcise(pivot, leaf.page, leaf.page, step())
    })
})

Sheaf.prototype.mergePages = cadence(function (step, key, leftKey, stopper, merger, ghostly) {
    var locker = this.createLocker(),
        descents = [], singles = { left: [], right: [] }, parents = {}, pages = {},
        ancestor, pivot, empties, ghosted, designation

    function createSingleUnlocker (singles) {
        ok(singles != null, 'null singles')
        return function (parent, child) {
            if (child.addresses.length == 1) {
                if (singles.length == 0) singles.push(parent)
                singles.push(child)
            } else if (singles.length) {
                singles.forEach(function (page) { locker.unlock(page) })
                singles.length = 0
            } else {
                locker.unlock(parent)
            }
        }
    }

    var keys = [ key ]
    if (leftKey) keys.push(leftKey)

    step(function () {
        step([function () {
            descents.forEach(function (descent) { locker.unlock(descent.page) })
            ! [ 'left', 'right' ].forEach(function (direction) {
                if (singles[direction].length) {
                    singles[direction].forEach(function (page) { locker.unlock(page) })
                } else {
                    locker.unlock(parents[direction].page)
                }
            })
            locker.dispose()
        }], function () {
            descents.push(pivot = new Descent(this, locker))
            pivot.descend(pivot.key(key), pivot.found(keys), step())
        }, function () {
            var found = pivot.page.cache[pivot.page.addresses[pivot.index]].key
            if (this.comparator(found, keys[0]) == 0) {
                pivot.upgrade(step())
            } else {
                step(function () { // left above right
                    pivot.upgrade(step())
                }, function () {
                    ghosted = { page: pivot.page, index: pivot.index }
                    descents.push(pivot = pivot.fork())
                    keys.pop()
                    pivot.descend(pivot.key(key), pivot.found(keys), step())
                })
            }
        }, function () {
            parents.right = pivot.fork()
            parents.right.unlocker = createSingleUnlocker(singles.right)
            parents.right.descend(parents.right.key(key), stopper(parents.right), step())
        }, function () {
            parents.left = pivot.fork()
            parents.left.index--
            parents.left.unlocker = createSingleUnlocker(singles.left)
            parents.left.descend(parents.left.right,
                                 parents.left.level(parents.right.depth),
                                 step())
        }, function () {
            if (singles.right.length) {
                ancestor = singles.right[0]
            } else {
                ancestor = parents.right.page
            }

            if (leftKey && !ghosted) {
                if (singles.left.length) {
                    ghosted = { page: singles.left[0], index: parents.left.indexes[singles.left[0].address] }
                } else {
                    ghosted = { page: parents.left.page, index: parents.left.index }
                    ok(parents.left.index == parents.left.indexes[parents.left.page.address], 'TODO: ok to replace the above')
                }
            }

            descents.push(pages.left = parents.left.fork())
            pages.left.descend(pages.left.left, pages.left.level(parents.left.depth + 1), step())
        }, function () {
            descents.push(pages.right = parents.right.fork())
            pages.right.descend(pages.right.left, pages.right.level(parents.right.depth + 1), step())
        }, function () {
            merger.call(this, pages, ghosted, step())
        }, function (dirty) {
            if (!dirty) return [ step ]
        }, function () {
            this.rename(pages.right.page, '', '.unlink', step())
        }, function () {
            var index = parents.right.indexes[ancestor.address]

            designation = ancestor.cache[ancestor.addresses[index]]

            var address = ancestor.addresses[index]
            this.splice('addresses', ancestor, index, 1)

            if (pivot.page.address != ancestor.address) {
                ok(!index, 'expected ancestor to be removed from zero index')
                ok(ancestor.addresses[index], 'expected ancestor to have right sibling')
                ok(ancestor.cache[ancestor.addresses[index]], 'expected key to be in memory')
                designation = ancestor.cache[ancestor.addresses[index]]
                this.uncacheEntry(ancestor, ancestor.addresses[0])
                this.uncacheEntry(pivot.page, pivot.page.addresses[pivot.index])
                this.encacheEntry(pivot.page, pivot.page.addresses[pivot.index], designation)
            } else{
                ok(index, 'expected ancestor to be non-zero')
                this.uncacheEntry(ancestor, address)
            }

            this.writeBranch(ancestor, '.pending', step())
        }, function () {
            step(function (page) {
                this.rename(page, '', '.unlink', step())
            })(singles.right.slice(1))
        }, function () {
            this.rename(ancestor, '.pending', '.commit', step())
        }, function () {
            step(function (page) {
                this.unlink(page, '.unlink', step())
            })(singles.right.slice(1))
        }, function () {
            this.replace(pages.left.page, '.replace', step())
        }, function () {
            this.unlink(pages.right.page, '.unlink', step())
        }, function () {
            this.replace(ancestor, '.commit', step())
        })
    }, function () {
        if (ancestor.address == 0) {
            if (ancestor.addresses.length == 1 && !(ancestor.addresses[0] % 2)) {
                this.fillRoot(step())
            }
        } else {
            this.chooseBranchesToMerge(designation.key, ancestor.address, step())
        }
    })
})

Sheaf.prototype.mergeLeaves = function (key, leftKey, unbalanced, ghostly, callback) {
    function stopper (descent) { return descent.penultimate }

    var merger = cadence(function (step, leaves, ghosted) {
        ok(leftKey == null ||
              this.comparator(leftKey, leaves.left.page.cache[leaves.left.page.positions[0]].key)  == 0,
              'left key is not as expected')

        var left = (leaves.left.page.positions.length - leaves.left.page.ghosts)
        var right = (leaves.right.page.positions.length - leaves.right.page.ghosts)

        this.unbalanced(leaves.left.page, true)

        var index
        if (left + right > this.options.leafSize) {
            if (unbalanced[leaves.left.page.address]) {
                this.unbalanced(leaves.left.page, true)
            }
            if (unbalanced[leaves.right.page.address]) {
                this.unbalanced(leaves.right.page, true)
            }
            return [ false ]
        } else {
            step(function () {
                if (ghostly && left + right) {
                    if (left) {
                        this.exorcise(ghosted, leaves.left.page, leaves.left.page, step())
                    } else {
                        this.exorcise(ghosted, leaves.left.page, leaves.right.page, step())
                    }
                }
            }, function () {
                leaves.left.page.right = leaves.right.page.right
                var ghosts = leaves.right.page.ghosts
                step(function (index) {
                    index += ghosts
                    step(function () {
                        this.stash(leaves.right.page, index, step())
                    }, function (entry) {
                        var position = leaves.right.page.positions[index]
                        this.uncacheEntry(leaves.right.page, position)
                        this.splice('positions', leaves.left.page, leaves.left.page.positions.length, 0, -(position + 1))
                        this.splice('lengths', leaves.left.page, leaves.left.page.lengths.length, 0, -(position + 1))
                        this.encacheEntry(leaves.left.page, -(position + 1), entry)
                    })
                })(leaves.right.page.positions.length - leaves.right.page.ghosts)
            }, function () {
                this.splice('positions', leaves.right.page, 0, leaves.right.page.positions.length)
                this.splice('lengths', leaves.right.page, 0, leaves.right.page.lengths.length)

                this.rewriteLeaf(leaves.left.page, '.replace', step())
            }, function () {
                return [ true ]
            })
        }
    })

    this.mergePages(key, leftKey, stopper, merger, ghostly, callback)
}

Sheaf.prototype.chooseBranchesToMerge = cadence(function (step, key, address) {
    var locker = this.createLocker(),
        descents = [],
        designator, choice, lesser, greater, center

    var goToPage = cadence(function (step, descent, address, direction) {
        step(function () {
            descents.push(descent)
            descent.descend(descent.key(key), descent.address(address), step())
        }, function () {
            descent.index += direction == 'left' ? 1 : -1
                                        // ^^^ This ain't broke.
            descent.descend(descent[direction], descent.level(center.depth), step())
        })
    })

    var choose = step(function () {
        step([function () {
            descents.forEach(function (descent) { locker.unlock(descent.page) })
            locker.dispose()
        }], function () {
            descents.push(center = new Descent(this, locker))
            center.descend(center.key(key), center.address(address), step())
        }, function () {
            if (center.lesser != null) {
                goToPage(lesser = new Descent(this, locker), center.lesser, 'right', step())
            }
        }, function () {
            if (center.greater != null) {
                goToPage(greater = new Descent(this, locker), center.greater, 'left', step())
            }
        }, function () {
            if (lesser && lesser.page.addresses.length + center.page.addresses.length <= this.options.branchSize) {
                choice = center
            } else if (greater && greater.page.addresses.length + center.page.addresses.length <= this.options.branchSize) {
                choice = greater
            }

            if (choice) {
                descents.push(designator = choice.fork())
                designator.index = 0
                designator.descend(designator.left, designator.leaf, step())
            } else {
                return [ choose ]
            }
        }, function () {
            this.stash(designator.page, 0, step())
        })
    }, function (entry) {
        this.mergeBranches(entry.key, entry.keySize, choice.page.address, step())
    })
})

Sheaf.prototype.mergeBranches = function (key, keySize, address, callback) {
    function stopper (descent) {
        return descent.child(address)
    }

    var merger = cadence(function (step, pages, ghosted) {
        ok(address == pages.right.page.address, 'unexpected address')

        var cut = this.splice('addresses', pages.right.page, 0, pages.right.page.addresses.length)

        var keys = {}
        cut.slice(1).forEach(function (address) {
            keys[address] = this.uncacheEntry(pages.right.page, address)
        }, this)

        this.splice('addresses', pages.left.page, pages.left.page.addresses.length, 0, cut)
        cut.slice(1).forEach(function (address) {
            this.encacheEntry(pages.left.page, address, keys[address])
        }, this)
        ok(cut.length, 'cut is zero length')
        this.encacheKey(pages.left.page, cut[0], key, keySize)

        step(function () {
            this.writeBranch(pages.left.page, '.replace', step())
        }, function () {
            return [ true ]
        })
    })

    this.mergePages(key, null, stopper, merger, false, callback)
}

Sheaf.prototype.fillRoot = cadence(function (step) {
    var locker = this.createLocker(), descents = [], root, child

    step([function () {
        descents.forEach(function (descent) { locker.unlock(descent.page) })
        locker.dispose()
    }], function () {
        descents.push(root = new Descent(this, locker))
        root.exclude()
        root.descend(root.left, root.level(0), step())
    }, function () {
        descents.push(child = root.fork())
        child.descend(child.left, child.level(1), step())
    }, function () {
        var cut
        ok(root.page.addresses.length == 1, 'only one address expected')
        ok(!Object.keys(root.page.cache).length, 'no keys expected')

        this.splice('addresses', root.page, 0, root.page.addresses.length)

        cut = this.splice('addresses', child.page, 0, child.page.addresses.length)

        var keys = {}
        cut.slice(1).forEach(function (address) {
            keys[address] = this.uncacheEntry(child.page, address)
        }, this)

        this.splice('addresses', root.page, root.page.addresses.length, 0, cut)
        cut.slice(1).forEach(function  (address) {
            this.encacheEntry(root.page, address, keys[address])
        }, this)

        this.writeBranch(root.page, '.pending', step())
    }, function () {
        this.rename(child.page, '', '.unlink', step())
    }, function () {
        this.rename(root.page, '.pending', '.commit', step())
    }, function () {
        this.unlink(child.page, '.unlink', step())
    }, function () {
        this.replace(root.page, '.commit', step())
    })
})

function Sheaf (options) {
    var writeFooter = function (out, position, page, callback) {
        this.writeFooter(out, position, page, callback)
    }.bind(this)
    this.fs = options.fs || require('fs')
    this.nextAddress = 0
    this.directory = options.directory
    this.journal = {
        branch: new Journalist({ stage: 'entry' }).createJournal(),
        leaf: new Journalist({
            stage: 'entry',
            closer: writeFooter
        }).createJournal()
    }
    this.journalist = new Journalist({
        count: options.fileHandleCount || 64,
        stage: options.writeStage || 'entry',
        cache: options.jouralistCache || (new Cache),
        closer: writeFooter
    })
    this.cache = options.cache || (new Cache)
    this.options = options
    this.tracer = options.tracer || function () { arguments[2]() }
    this.sequester = options.sequester || require('sequester')
    this.extractor = options.extractor || extract
    this.comparator = options.comparator || compare
    this.checksum = (function () {
        if (typeof options.checksum == 'function') return options.checksum
        var algorithm
        switch (algorithm = options.checksum || 'sha1') {
        case 'none':
            return function () {
                return {
                    update: function () {},
                    digest: function () { return '0' }
                }
            }
        default:
            var crypto = require('crypto')
            return function (m) { return crypto.createHash(algorithm) }
        }
    })()
    this.serialize = options.serialize || function (object) { return new Buffer(JSON.stringify(object)) }
    this.deserialize = options.deserialize || function (buffer) { return JSON.parse(buffer.toString()) }
    this.createJournal = (options.writeStage == 'tree' ? (function () {
        var journal = this.journalist.createJournal()
        return function () { return journal }
    }).call(this) : function () {
        return this.journalist.createJournal()
    })
    this.lengths = {}
}

Sheaf.prototype.writeFooter = cadence(function (step, out, position, page) {
    ok(page.address % 2 && page.bookmark != null)
    var header = [
        0, page.bookmark.position, page.bookmark.length, page.bookmark.entry,
        page.right || 0, page.position, page.entries, page.ghosts, page.positions.length - page.ghosts
    ]
    step(function () {
        this.writeEntry({
            out: out,
            page: page,
            header: header,
            type: 'footer'
        }, step())
    }, function (position, length) {
        page.position = header[5] // todo: can't we use `position`?
        return [ position, length ]
    })
})

Sheaf.prototype.readEntry = function (buffer, isKey) {
    for (var count = 2, i = 0, I = buffer.length; i < I && count; i++) {
        if (buffer[i] == 0x20) count--
    }
    for (count = 1; i < I && count; i++) {
        if (buffer[i] == 0x20 || buffer[i] == 0x0a) count--
    }
    ok(!count, 'corrupt line: could not find end of line header')
    var fields = buffer.toString('utf8', 0, i - 1).split(' ')
    var hash = this.checksum(), body, length
    hash.update(fields[2])
    if (buffer[i - 1] == 0x20) {
        body = buffer.slice(i, buffer.length - 1)
        length = body.length
        hash.update(body)
    }
    var digest = hash.digest('hex')
    ok(fields[1] == '-' || digest == fields[1], 'corrupt line: invalid checksum')
    if (buffer[i - 1] == 0x20) {
        body = this.deserialize(body, isKey)
    }
    var entry = { length: length, header: JSON.parse(fields[2]), body: body }
    ok(entry.header.every(function (n) { return typeof n == 'number' }), 'header values must be numbers')
    return entry
}

Sheaf.prototype.filename = function (address, suffix) {
    suffix || (suffix = '')
    return path.join(this.directory, address + suffix)
}

Sheaf.prototype.replace = cadence(function (step, page, suffix) {
    var replacement = this.filename(page.address, suffix),
        permanent = this.filename(page.address)

    step(function () {
        this.fs.stat(replacement, step())
    }, function (stat) {
        ok(stat.isFile(), 'is not a file')
        step([function () {
            this.fs.unlink(permanent, step())
        }, /^ENOENT$/, function () {
            // todo: regex only is a catch and swallow?
        }])
    }, function (ror) {
        this.fs.rename(replacement, permanent, step())
    })
})

Sheaf.prototype.rename = function (page, from, to, callback) {
    this.fs.rename(this.filename(page.address, from), this.filename(page.address, to), callback)
}

Sheaf.prototype.unlink = function (page, suffix, callback) {
    this.fs.unlink(this.filename(page.address, suffix), callback)
}

Sheaf.prototype.heft = function (page, s) {
    this.magazine.get(page.address).adjustHeft(s)
}

Sheaf.prototype.createLeaf = function (override) {
    return this.createPage({
        cache: {},
        loaders: {},
        entries: 0,
        ghosts: 0,
        positions: [],
        lengths: [],
        right: 0,
        queue: this.sequester.createQueue()
    }, override, 0)
}

Sheaf.prototype._cacheRecord = function (page, position, record, length) {
    var key = this.extractor(record)
    ok(key != null, 'null keys are forbidden')

    var entry = {
        record: record,
        size: length,
        key: key,
        keySize: this.serialize(key, true).length
    }

    return this.encacheEntry(page, position, entry)
}

Sheaf.prototype.encacheEntry = function (page, reference, entry) {
    ok (!page.cache[reference], 'record already cached for position')

    page.cache[reference] = entry

    this.heft(page, entry.size)

    return entry
}

Sheaf.prototype.uncacheEntry = function (page, reference) {
    var entry = page.cache[reference]
    ok (entry, 'entry not cached')
    this.heft(page, -entry.size)
    delete page.cache[reference]
    return entry
}

Sheaf.prototype.writeEntry = cadence(function (step, options) {
    var entry, buffer, json, line, length

    ok(options.page.position != null, 'page has not been positioned: ' + options.page.position)
    ok(options.header.every(function (n) { return typeof n == 'number' }), 'header values must be numbers')

    if (options.type == 'position') {
        options.page.bookmark = { position: options.page.position }
    }

    entry = options.header.slice()
    json = JSON.stringify(entry)
    var hash = this.checksum()
    hash.update(json)

    length = 0

    var separator = ''
    if (options.body != null) {
        var body = this.serialize(options.body, options.isKey)
        separator = ' '
        length += body.length
        hash.update(body)
    }

    line = hash.digest('hex') + ' ' + json + separator

    length += Buffer.byteLength(line, 'utf8') + 1

    var entire = length + String(length).length + 1
    if (entire < length + String(entire).length + 1) {
        length = length + String(entire).length + 1
    } else {
        length = entire
    }

    buffer = new Buffer(length)
    buffer.write(String(length) + ' ' + line)
    if (options.body != null) {
        body.copy(buffer, buffer.length - 1 - body.length)
    }
    buffer[length - 1] = 0x0A

    if (options.type == 'position') {
        options.page.bookmark.length = length
        options.page.bookmark.entry = entry[0]
    }

    var position = options.page.position

    step(function () {
        options.out.write(buffer, step())
    }, function () {
        options.page.position += length
        return [ position, length, body && body.length ]
    })
})

Sheaf.prototype.writeInsert = function (out, page, index, record, callback) {
    var header = [ ++page.entries, index + 1 ]
    this.writeEntry({ out: out, page: page, header: header, body: record }, callback)
}

Sheaf.prototype.writeDelete = function (out, page, index, callback) {
    var header = [ ++page.entries, -(index + 1) ]
    this.writeEntry({ out: out, page: page, header: header }, callback)
}

Sheaf.prototype.io = cadence(function (step, direction, filename) {
    step(function () {
        this.fs.open(filename, direction[0], step())
    }, function (fd) {
        step(function () {
            this.fs.fstat(fd, step())
        }, function (stat) {
            var fs = this.fs, io = cadence(function (step, buffer, position) {
                var offset = 0

                var length = stat.size - position
                var slice = length < buffer.length ? buffer.slice(0, length) : buffer

                var loop = step(function (count) {
                    if (count < slice.length - offset) {
                        offset += count
                        fs[direction](fd, slice, offset, slice.length - offset, position + offset, step())
                    } else {
                        return [ loop, slice, position ]
                    }
                })(null, 0)
            })
            return [ fd, stat, io ]
        })
    })
})

Sheaf.prototype.writePositions = function (output, page, callback) {
    var header = [ ++page.entries, 0, page.ghosts ]
    header = header.concat(page.positions).concat(page.lengths)
    this.writeEntry({ out: output, page: page, header: header, type: 'position' }, callback)
}

Sheaf.prototype.readHeader = function (entry) {
    var header = entry.header
    return {
        entry:      header[0],
        index:      header[1],
        address:    header[2]
    }
}

Sheaf.prototype.readFooter = function (entry) {
    var footer = entry.header
    return {
        entry:      footer[0],
        bookmark: {
            position:   footer[1],
            length:     footer[2],
            entry:      footer[3]
        },
        right:      footer[4],
        position:   footer[5],
        entries:    footer[6],
        ghosts:     footer[7],
        records:    footer[8]
    }
}

Sheaf.prototype.findPositionsArray = cadence(function (step, page, fd, stat, read) {
    var positions = [],
        lengths = [],
        bookmark
    var buffer = new Buffer(this.options.readLeafStartLength || 1024)
    step(function () {
        read(buffer, Math.max(0, stat.size - buffer.length), step())
    }, function (slice) {
        for (var i = slice.length - 2; i != -1; i--) {
            if (slice[i] == 0x0a) {
                var footer = this.readFooter(this.readEntry(slice.slice(i + 1)))
                ok(!footer.entry, 'footer is supposed to be zero')
                bookmark = footer.bookmark
                page.right = footer.right
                page.position = footer.position
                ok(page.position != null, 'no page position')
                read(new Buffer(bookmark.length), bookmark.position, step())
                return
            }
        }
        throw new Error('cannot find footer in last ' + buffer.length + ' bytes')
    }, function (slice) {
        var positions = this.readEntry(slice.slice(0, bookmark.length)).header

        page.entries = positions.shift()
        ok(page.entries == bookmark.entry, 'position entry number incorrect')
        ok(positions.shift() == 0, 'expected housekeeping type')

        page.ghosts = positions.shift()

        ok(!(positions.length % 2), 'expecting even number of positions and lengths')
        var lengths = positions.splice(positions.length / 2)

        this.splice('positions', page, 0, 0, positions)
        this.splice('lengths', page, 0, 0, lengths)

        page.bookmark = bookmark

        return [ page, bookmark.position + bookmark.length ]
    })
})

Sheaf.prototype.readLeaf = cadence(function (step, page) {
    step(function () {
        this.io('read', this.filename(page.address), step())
    }, function (fd, stat, read) {
        step(function () {
            if (this.options.replay) {
                page.entries = 0
                page.ghosts = 0
                return [ page, 0 ]
            } else {
                this.findPositionsArray(page, fd, stat, read, step())
            }
        }, function (page, position) {
            this.replay(fd, stat, read, page, position, step())
        }, function () {
            return [ page ]
        })
    })
})

Sheaf.prototype.replay = cadence(function (step, fd, stat, read, page, position) {
    var leaf = !!(page.address % 2),
        seen = {},
        buffer = new Buffer(this.options.readLeafStartLength || 1024),
        footer, length

    // todo: really want to register a cleanup without an indent.
    step([function () {
        this.fs.close(fd, step())
    }], function () {
        var loop = step(function (buffer, position) {
            read(buffer, position, step())
        }, function (slice, start) {
            for (var offset = 0, i = 0, I = slice.length; i < I; i++) {
                ok(!footer, 'data beyond footer')
                if (slice[i] == 0x20) {
                    var sip = slice.toString('utf8', offset, i)
                    length = parseInt(sip)
                    ok(String(length).length == sip.length, 'invalid length')
                    if (offset + length > slice.length) {
                        break
                    }
                    var position = start + offset
                    ok(length)
                    var entry = this.readEntry(slice.slice(offset, offset + length), !leaf)
                    var header = this.readHeader(entry)
                    if (header.entry) {
                        ok(header.entry == ++page.entries, 'entry count is off')
                        var index = header.index
                        if (leaf) {
                            if (index > 0) {
                                seen[position] = true
                                this.splice('positions', page, index - 1, 0, position)
                                this.splice('lengths', page, index - 1, 0, length)
                                this._cacheRecord(page, position, entry.body, entry.length)
                            } else if (~index == 0 && page.address != 1) {
                                ok(!page.ghosts, 'double ghosts')
                                page.ghosts++
                            } else if (index < 0) {
                                var outgoing = this.splice('positions', page, -(index + 1), 1).shift()
                                if (seen[outgoing]) this.uncacheEntry(page, outgoing)
                                this.splice('lengths', page, -(index + 1), 1)
                            } else {
                                page.bookmark = {
                                    position: position,
                                    length: length,
                                    entry: header.entry
                                }
                            }
                        } else {
                            /* if (index > 0) { */
                                var address = header.address
                                this.splice('addresses', page, index - 1, 0, address)
                                if (index - 1) {
                                    this.encacheKey(page, address, entry.body, entry.length)
                                }
                            /* } else {
                                var cut = splice('addresses', page, ~index, 1)
                                if (~index) {
                                    uncacheEntry(page, cut[0])
                                }
                            } */
                        }
                    } else {
                        footer = this.readFooter(entry)
                        page.position = position
                        page.right = footer.right
                    }
                    i = offset = offset + length
                }
            }

            if (start + buffer.length < stat.size) {
                if (offset == 0) {
                    buffer = new Buffer(buffer.length * 2)
                    read(buffer, start, step())
                } else {
                    read(buffer, start + offset, step())
                }
            } else {
                return [ loop, page, footer ]
            }
        })(null, buffer, position)
    })
})

Sheaf.prototype.readRecord = cadence(function (step, page, position, length) {
    step(function () {
        this.io('read', this.filename(page.address), step())
    }, function (fd, stat, read) {
        step([function () {
            // todo: test what happens when a finalizer throws an error
            this.fs.close(fd, step())
        }],function () {
            this.tracer('readRecord', { page: page }, step())
        }, function () {
            read(new Buffer(length), position, step())
        }, function (buffer) {
            ok(buffer[length - 1] == 0x0A, 'newline expected')
            return [ this.readEntry(buffer, false) ]
        })
    })
})

Sheaf.prototype.rewriteLeaf = cadence(function (step, page, suffix) {
    var cache = {}, index = 0, out

    step(function () {
        out = this.journal.leaf.open(this.filename(page.address, suffix), 0, page)
        out.ready(step())
    }, [function () {
        // todo: ensure that cadence finalizers are registered in order.
        // todo: also, don't you want to use a specific finalizer above?
        // todo: need an error close!
        out.scram(step())
    }], function () {
        page.position = 0
        page.entries = 0

        var positions = this.splice('positions', page, 0, page.positions.length)
        var lengths = this.splice('lengths', page, 0, page.lengths.length)

        step(function () {
            this.writePositions(out, page, step())
        }, function () {
            step(function (position) {
                var length = lengths.shift()
                step(function () {
                    this.stash(page, position, length, step())
                }, function (entry) {
                    step(function () {
                        this.uncacheEntry(page, position)
                        this.writeInsert(out, page, index++, entry.record, step())
                    }, function (position, length) {
                        cache[position] = entry
                        this.splice('positions', page, page.positions.length, 0, position)
                        this.splice('lengths', page, page.lengths.length, 0, length)
                    })
                })
            })(positions)
        })
    }, function () {
        if (page.positions.length) {
            var entry
            for (var position in cache) {
                entry = cache[position]
                this.encacheEntry(page, position, entry)
            }
            this.writePositions(out, page, step())
        }
    }, function () {
        out.close('entry', step())
    })
})

Sheaf.prototype.createPage = function (page, override, remainder) {
    if (override.address == null) {
        while ((this.nextAddress % 2) == remainder) this.nextAddress++
        override.address = this.nextAddress++
    }
    return extend(page, override)
}

Sheaf.prototype.createBranch = function (override) {
    return this.createPage({
        addresses: [],
        cache: {},
        entries: 0,
        penultimate: true,
        queue: this.sequester.createQueue()
    }, override, 1)
}

Sheaf.prototype.splice = function (collection, page, offset, length, insert) {
    ok(typeof collection == 'string', 'incorrect collection passed to splice')

    var values = page[collection], json, removals

    ok(values, 'incorrect collection passed to splice')

    if (length) {
        removals = values.splice(offset, length)

        json = values.length == 0 ? '[' + removals.join(',') + ']'
                                                            : ',' + removals.join(',')

        this.heft(page, -json.length)
    } else {
        removals = []
    }

    if (insert != null) {
        if (! Array.isArray(insert)) insert = [ insert ]
        if (insert.length) {
            json = values.length == 0 ? '[' + insert.join(',') + ']'
                                                                : ',' + insert.join(',')

            this.heft(page, json.length)

            values.splice.apply(values, [ offset, 0 ].concat(insert))
        }
    }
    return removals
}

Sheaf.prototype.encacheKey = function (page, address, key, length) {
    return this.encacheEntry(page, address, { key: key, size: length })
}

Sheaf.prototype.writeBranch = cadence(function (step, page, suffix) {
    var keys = page.addresses.map(function (address, index) {
            return page.cache[address]
        }),
        out

    ok(keys[0] === (void(0)), 'first key is null')
    ok(keys.slice(1).every(function (key) { return key != null }), 'null keys')

    step(function () {
        page.entries = 0
        page.position = 0

        out = this.journal.branch.open(this.filename(page.address, suffix), 0, page)
        out.ready(step())
    }, [function () {
        out.scram(step())
    }], function () {
        step(function (address) {
            var key = page.entries ? page.cache[address].key : null
            page.entries++
            var header = [ page.entries, page.entries, address ]
            this.writeEntry({
                out: out,
                page: page,
                header: header,
                body: key,
                isKey: true
            }, step())
        })(page.addresses)
    }, function () {
        out.close('entry', step())
    })
})

Sheaf.prototype.readBranch = cadence(function (step, page) {
    step(function () {
        this.io('read', this.filename(page.address), step())
    }, function (fd, stat, read) {
        this.replay(fd, stat, read, page, 0, step())
    })
})

Sheaf.prototype.createMagazine = function () {
    var magazine = this.cache.createMagazine()
    var dummy = magazine.hold(-2, {
        page: {
            address: -2,
            addresses: [ 0 ],
            queue: this.sequester.createQueue()
        }
    }).value.page
    dummy.lock = dummy.queue.createLock()
    dummy.lock.share(function () {})
    this.magazine = magazine
}

Sheaf.prototype.createLocker = function () {
    return new Locker(this, this.magazine)
}

Sheaf.prototype.stash = cadence(function (step, page, positionOrIndex, length) {
    var position = positionOrIndex
    if (arguments.length == 3) {
        position = page.positions[positionOrIndex]
        length = page.lengths[positionOrIndex]
    }
    ok(length)
    var entry, loader
    if (loader = page.loaders[position]) {
        loader.share(step())
    } else if (!(entry = page.cache[position])) {
        loader = page.loaders[position] = this.sequester.createLock()
        loader.exclude(function () {
            this.readRecord(page, position, length, function (error, entry) {
                delete page.loaders[position]
                if (!error) {
                    delete page.cache[position]
                    var entry = this._cacheRecord(page, position, entry.body, entry.length)
                }
                loader.unlock(error, entry, length)
            }.bind(this))
        }.bind(this))
        this.stash(page, position, length, step())
    } else {
        return [ entry, length ]
    }
})

Sheaf.prototype._find = cadence(function (step, page, key, low) {
    var mid, high = (page.addresses || page.positions).length - 1

    if (page.address % 2 == 0) {
        while (low <= high) {
            mid = low + ((high - low) >>> 1)
            var compare = this.comparator(key, page.cache[page.addresses[mid]].key)
            if (compare < 0) high = mid - 1
            else if (compare > 0) low = mid + 1
            else return mid
        }
        return [ ~low ]
    }

    var loop = step(function () {
        if (low <= high) {
            mid = low + ((high - low) >>> 1)
            this.stash(page, mid, step())
        } else {
            return [ loop, ~low ]
        }
    }, function (entry) {
        ok(entry.key != null, 'key is null in find')
        var compare = this.comparator(key, entry.key)
        if (compare == 0) {
            return [ loop, mid ]
        } else {
            if (compare > 0) low = mid + 1
            else high = mid - 1
        }
    })()
})

function Strata (options) {
    this.sheaf = new Sheaf(options)
}

Strata.prototype.__defineGetter__('size', function () {
    return this.sheaf.magazine.heft
})

Strata.prototype.__defineGetter__('nextAddress', function () {
    return this.sheaf.nextAddress
})

// to user land
Strata.prototype.create = cadence(function (step) {
    this.sheaf.createMagazine()

    var locker = this.sheaf.createLocker(), count = 0, root, leaf, journal

    step([function () {
        locker.dispose()
    }], function () {
        this.sheaf.fs.stat(this.sheaf.directory, step())
    }, function (stat) {
        ok(stat.isDirectory(), 'database ' + this.sheaf.directory + ' is not a directory.')
        this.sheaf.fs.readdir(this.sheaf.directory, step())
    }, function (files) {
        ok(!files.filter(function (f) { return ! /^\./.test(f) }).length,
              'database ' + this.sheaf.directory + ' is not empty.')

        root = locker.encache(this.sheaf.createBranch({ penultimate: true }))
        leaf = locker.encache(this.sheaf.createLeaf({}))
        this.sheaf.splice('addresses', root, 0, 0, leaf.address)

        this.sheaf.writeBranch(root, '.replace', step())
    }, [function () {
        locker.unlock(root)
    }], function () {
        this.sheaf.rewriteLeaf(leaf, '.replace', step())
    }, [function () {
        locker.unlock(leaf)
    }], function () {
        this.sheaf.replace(root, '.replace', step())
    }, function branchReplaced () {
        this.sheaf.replace(leaf, '.replace', step())
    })
})

// to user land
Strata.prototype.open = cadence(function (step) {
    this.sheaf.createMagazine()

    // todo: instead of rescue, you might try/catch the parts that you know
    // are likely to cause errors and raise an error of a Strata type.

    // todo: or you might need some way to catch a callback error. Maybe an
    // outer most catch block?

    // todo: or if you're using Cadence, doesn't the callback get wrapped
    // anyway?
    step(function () {
        this.sheaf.fs.stat(this.sheaf.directory, step())
    }, function stat (error, stat) {
        this.sheaf.fs.readdir(this.sheaf.directory, step())
    }, function (files) {
        files.forEach(function (file) {
            if (/^\d+$/.test(file)) {
                this.sheaf.nextAddress = Math.max(+(file) + 1, this.sheaf.nextAddress)
            }
        }, this)
    })
})

// to user land
Strata.prototype.close = cadence(function (step) {
    var cartridge = this.sheaf.magazine.get(-2), lock = cartridge.value.page.lock
    step(function () {
        this.sheaf.createJournal().close('tree', step())
    }, function () {
        lock.unlock()
        // todo
        lock.dispose()

        cartridge.release()

        var purge = this.sheaf.magazine.purge()
        while (purge.cartridge) {
            purge.cartridge.remove()
            purge.next()
        }
        purge.release()

        ok(!this.sheaf.magazine.count, 'pages still held by cache')
    })
})

Strata.prototype.left = function (descents, exclusive, callback) {
    this.toLeaf(descents[0].left, descents, null, exclusive, callback)
}

Strata.prototype.right = function (descents, exclusive, callback) {
    this.toLeaf(descents[0].right, descents, null, exclusive, callback)
}

Strata.prototype.key = function (key) {
    return function (descents, exclusive, callback) {
        this.toLeaf(descents[0].key(key), descents, null, exclusive, callback)
    }
}

Strata.prototype.leftOf = function (key) {
    return cadence(function (step, descents, exclusive) {
        var conditions = [ descents[0].leaf, descents[0].found([key]) ]
        step(function () {
            descents[0].descend(descents[0].key(key), function () {
                return conditions.some(function (condition) {
                    return condition.call(descents[0])
                })
            }, step())
        }, function (page, index) {
            if (descents[0].page.address % 2) {
                return [ new Cursor(this.sheaf, this.sheaf.createJournal(), descents, false, key) ]
            } else {
                descents[0].index--
                this.toLeaf(descents[0].right, descents, null, exclusive, step())
            }
        })
    })
}

Strata.prototype.toLeaf = cadence(function (step, sought, descents, key, exclusive) {
    step(function () {
        descents[0].descend(sought, descents[0].penultimate, step())
    }, function () {
        if (exclusive) descents[0].exclude()
        descents[0].descend(sought, descents[0].leaf, step())
    }, function () {
        return [ new Cursor(this.sheaf, this.sheaf.createJournal(), descents, exclusive, key) ]
    })
})

// to user land
Strata.prototype.cursor = cadence(function (step, key, exclusive) {
    var descents = [ new Descent(this.sheaf, this.sheaf.createLocker()) ]
    step([function () {
        if (descents.length) {
            descents[0].locker.unlock(descents[0].page)
            descents[0].locker.dispose()
        }
    }], function () {
        if  (typeof key == 'function') {
            key.call(this, descents, exclusive, step())
        } else {
            this.toLeaf(descents[0].key(key), descents, key, exclusive, step())
        }
    }, function (cursor) {
        return [ cursor ]
    })
})

Strata.prototype.iterator = function (key, callback) {
    this.cursor(key, false, callback)
}

Strata.prototype.mutator = function (key, callback) {
    this.cursor(key, true, callback)
}

// to user land
Strata.prototype.balance = function (callback) {
    this.sheaf.balance(callback)
}

// to user land
Strata.prototype.vivify = cadence(function (step) {
    var locker = this.sheaf.createLocker(), root

    function record (address) {
        return { address: address }
    }

    step(function () {
        locker.lock(0, false, step())
    }, function (page) {
        step([function () {
            locker.unlock(page)
            locker.dispose()
        }], function () {
            expand.call(this, page, root = page.addresses.map(record), 0, step())
        })
    })

    var expand = cadence(function (step, parent, pages, index) {
        var block = step(function () {
            if (index < pages.length) {
                var address = pages[index].address
                locker.lock(address, false, step(step)([function (page) { locker.unlock(page) }]))
            } else {
                return [ block, pages ]
            }
        }, function (page) {
            if (page.address % 2 == 0) {
                step(function () {
                    pages[index].children = page.addresses.map(record)
                    if (index) {
                        pages[index].key = parent.cache[parent.addresses[index]].key
                    }
                    expand.call(this, page, pages[index].children, 0, step())
                }, function () {
                    expand.call(this, parent, pages, index + 1, step())
                })
            } else {
                step(function () {
                    pages[index].children = []
                    pages[index].ghosts = page.ghosts

                    step(function (recordIndex) {
                        step(function () {
                            this.sheaf.stash(page, recordIndex, step())
                        }, function (entry) {
                            pages[index].children.push(entry.record)
                        })
                    })(page.positions.length)
                }, function () {
                    expand.call(this, parent, pages, index + 1, step())
                })
            }
        })(1)
    })
})

Strata.prototype.purge = function (downTo) {
    var purge = this.sheaf.magazine.purge()
    while (purge.cartridge && this.sheaf.magazine.heft > downTo) {
        purge.cartridge.remove()
        purge.next()
    }
    purge.release()
}

Strata.prototype.__defineGetter__('balanced', function () {
    return ! Object.keys(this.sheaf.lengths).length
})

module.exports = Strata
