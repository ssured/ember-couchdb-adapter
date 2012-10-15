(function(){
  // Copyright (c) Clemens Müller, @pangratz, 2012
  // Copyright (c) Sjoerd de Jong, @ssured, 2012
  // 
  // Permission to use, copy, modify, and/or distribute this software for any
  // purpose with or without fee is hereby granted, provided that the above
  // copyright notice and this permission notice appear in all copies.
  // 
  // THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
  // WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
  // MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
  // ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
  // WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
  // ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
  // OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

  var get = Ember.get, set = Ember.set;
  
  DS.Model.reopen({
    addDirtyFactor: function(name) {
      // in the CouchDB setup, the belongsTo record defines the association
      // this code makes sure changing hasMany associations do not dirty the record
      // TODO: this should either be moved to a mixin, or (preferred) moved into the adapter
      var association = get(this.constructor, 'associationsByName').get(name);
      if (association && association.isAssociation && association.kind == 'hasMany') {
        return;
      } else {
        this._super(name);
      }
    },
    remoteUpdateRecord: function(change) {
      // TODO: optimize this logic
      Ember.changeProperties(function(){
        var data = $.extend(this.toJSON({ includeId: true }), change.doc); 
        this.get('store.adapter.serializer').addHasManyRelationships(data, this);
        get(this, 'store').load(this.constructor, data);
      }, this);
    },
    onRemoteUpdateConflict: function(change) {
      this.set('data.attributes.rev',change.changes[0].rev);
    },
    remoteDeleteRecord: function(change) {
      if (!this.get('isDeleted')) {
        Ember.changeProperties(function(){
          // delete the record in a separate transaction, while temporarily disabling communication with the backend
          var store = get(this, 'store');
          var transaction = store.transaction();
          transaction.add(this);
          this.deleteRecord();
          this.set('data.attributes._remote_deleted', true); // mark for silent deletion
          transaction.commit();
        }, this);
      }
    },
    onRemoteDeleteConflict: function(change) {
      this.set('data.attributes.rev',change.changes[0].rev);
    }
  });
  
  DS.Store.reopen({
    load: function(type, id, _hash) {
      // TODO, maybe this logic should be put in  store.materializeRecord: function(type, clientId, id) ??
      var result = this._super(type, id, _hash);
      var belongsToRecord, hasManyKey, hasManyClientId, hasManyRecord;
      
      // automatically load the belongsTo relationship
      // in this couchdb adapter belongsTo relationships are considered stronger than hasMany
      var hash = this.clientIdToHash[result.clientId];
      get(type, 'associationsByName').forEach(function(name, relationship) {
        if (relationship.kind === 'belongsTo') {
          // try to find the cached parent object and figure out the remote key
          if ((hasManyClientId = this.typeMapFor(relationship.type).idToCid[hash[relationship.key]]) && 
                (hasManyKey = DS.inverseNameFor(relationship.type, type, 'hasMany'))) {
            // get the records involved
            belongsToRecord = this.findByClientId(type, result.clientId);
            hasManyRecord =   this.findByClientId(relationship.type, hasManyClientId);
            if (belongsToRecord && hasManyRecord) {
              // apply the relation, but do not dirty the belongsTo record, as it's already referencing the correct object
              hasManyRecord.suspendAssociationObservers(function(){
                hasManyRecord.get(hasManyKey).addToContent(belongsToRecord);
              });
            }
          }
        }
      }, this);
      
      return result;
    }
  });
  
  // var oldSync = DS.OneToManyChange.prototype.sync;
  // DS.OneToManyChange.prototype.sync = function(){
  //   if (this.getHasManyName()) oldSync.apply(this);
  // }
  
  DS.CouchDBSerializer = DS.Serializer.extend({
    materializeFromJSON: function(record, hash) {
      var result = this._super(record, hash);
      if (hash && hash.rev) {
        record.materializeAttribute('rev', hash.rev);
      }
      return result;
    },
    addHasManyRelationships: function(hash, record) {
      record.eachAssociation(function(name, relationship) {
        var key = this._keyForAttributeName(record.constructor, name);

        if (relationship.kind === 'hasMany') {
          this.addHasMany(hash, record, key, relationship);
        }
      }, this);
    },
    addBelongsToRelationships: function(hash, record) {
      record.eachAssociation(function(name, relationship) {
        var key = this._keyForAttributeName(record.constructor, name);

        if (relationship.kind === 'belongsTo') {
          this.addBelongsTo(hash, record, key, relationship);
        }
      }, this);
    },
    addRelationships: function(hash, record) {
      this.addBelongsToRelationships(hash, record);
      var type = record.constructor;
      var adapter = get(record, 'store.adapter');
      var meta = {
        type: adapter.stringForType(type),
      };
      
      if (get(type, 'associationNames.belongsTo.length')){
        meta.belongsTo = get(type, 'associationNames.belongsTo').map(function(name){return this.keyForBelongsTo(type, name);},this);
      }        

      hash[adapter.get('metaAttribute')] = meta;
    },
    addBelongsTo: function(hash, record, key, relationship) {
      hash[this.keyForBelongsTo(record.constructor, key)] = record.get(key+'.id');
    },
    addHasMany: function(hash, record, key, relationship) {
      if (record.get(key+'.content.length')) {
        hash[this.keyForHasMany(record.constructor, key)] = record.get(key).map(function(record){return record.get('id');});
      }
    }
  });
  
  DS.CouchDBAdapter = DS.Adapter.extend({
    metaAttribute: 'ember_data',
    
    // define a map function in CouchDB for fetching data by type
    //   function (doc) {
    //     if (doc.ember_data && doc.ember_data.type) emit(doc.ember_data.type);
    //   }
    typeViewName: 'by-ember-type',

    // define a map function in CouchDB for fetching data by association
      // function (doc) {
      //   if (doc.ember_data && doc.ember_data.type && doc.ember_data.belongsTo) {
      //     for (i=0; i<doc.ember_data.belongsTo.length; i++){
      //       association = doc.ember_data.belongsTo[i];
      //       if (doc[association])
      //         emit(doc[association], doc.ember_data.type);
      //     }
      //   }
      // }
    associationsViewName: 'by-ember-association',
    
    customTypeLookup: false,

    serializer: DS.CouchDBSerializer.create({
      // You can pass in a different key: naming strategy here, see the setup of REST Adapter
      // keyForBelongsTo: function(type, name) {
      //   return this.keyForAttributeName(type, name) + '_id';
      // },
      // 
      // keyForAttributeName: function(type, name) {
      //   return Ember.String.decamelize(name);
      // }
    }),

    _ajax: function(url, type, hash) {
      hash.url = url;
      hash.type = type;
      hash.dataType = 'json';
      hash.contentType = 'application/json; charset=utf-8';
      hash.context = this;

      if (hash.data && type !== 'GET') {
        hash.data = JSON.stringify(hash.data);
      }

      Ember.$.ajax(hash);
    },

    ajax: function(url, type, hash) {
      var db = this.get('db');
      return this._ajax('/%@/%@'.fmt(db, url || ''), type, hash);
    },

    stringForType: function(type) {
      return type.toString();
    },

    _loadMany: function(store, type, docs) {
      var ids = []; // holds the ids of all docs
      
      if (typeof(type) === 'string') {
        type = get(window, type);
      }
    
      // CouchDB returns id and revision of a document via _id and _rev, so we need to map it to id and rev
      docs = docs.map(function(record) {
        record.id = record._id;
        record.rev = record._rev;
        delete record._id;
        delete record._rev;
      
        ids.push(record.id);
        return record;
      });
    
      // determine if this object type has 'hasMany' relations, if so, these need to be loaded separate from a special view
      var needsHasManyLoading = false;
      if (get(type, 'associationNames.hasMany.length')) {
        get(type, 'associationNames.hasMany').forEach(function(attributeName){
          for (var i=0; i<docs.length; i++){
            needsHasManyLoading |= undefined === docs[i][attributeName];
          }
        });
      }
      
      if (needsHasManyLoading) {
        this.ajax('_design/%@/_view/%@'.fmt(get(this, 'designDoc'), get(this, 'associationsViewName')), 'POST', {
          data: { keys: ids },
          context: this,
          success: function(relationData) {
            // TODO make this matching algorithm more efficient, current approach is O(n^2)
            for (var i=0; i<docs.length; i++){
              relationData.rows.forEach(function(relation){
                if (relation.key == docs[i].id) {
                  var foreignType = get(window, relation.value);
                  var property = DS.inverseNameFor(type, foreignType, 'hasMany');
                  if (property) {
                    if (!docs[i][property]) docs[i][property] = [];
                    docs[i][property].push(relation.id);
                  }
                }
              });
            }
            store.loadMany(type, docs);
          }
        });
      } else {
        store.loadMany(type, docs);
      }    
    },

    find: function(store, type, id) {
      this.ajax(id, 'GET', {
        context: this,
        success: function(data) {
          this._loadMany(store, type, [data]);
        }
      });
    },

    findMany: function(store, type, ids) {
      this.ajax('_all_docs?include_docs=true', 'POST', {
        data: { keys: ids },
        context: this,
        success: function(data) {
          this._loadMany(store, type, data.rows.getEach('doc'));
        }
      });
    },

    findQuery: function(store, type, query, modelArray) {
      var designDoc = this.get('designDoc');
      if (query.type === 'view') {
        this.ajax('_design/%@/_view/%@'.fmt(query.designDoc || designDoc, query.viewName), 'GET', {
          data: query.options,
          success: function(data) {
            this._loadMany(modelArray, type, data);
          },
          context: this
        });
      }
    },

    findAll: function(store, type) {
      var designDoc = this.get('designDoc');
      if (this.get('customTypeLookup') === true && this.viewForType) {
        var params = {};
        var viewName = this.viewForType(type, params);
        params.include_docs = true;
        this.ajax('_design/%@/_view/%@'.fmt(designDoc, viewName), 'GET', {
          data: params,
          context: this,
          success: function(data) {
            this._loadMany(store, type, data.rows.getEach('doc'));
          }
        });
      } else {
        var typeViewName = this.get('typeViewName');
        var typeString = this.stringForType(type);
        this.ajax('_design/%@/_view/%@?include_docs=true&key="%@"'.fmt(designDoc, typeViewName, typeString), 'GET', {
          context: this,
          success: function(data) {
            this._loadMany(store, type, data.rows.getEach('doc'));
          }
        });
      }
    },

    createRecord: function(store, type, record) {
      var json = record.toJSON({ includeId: true });
      if (json.id) {
        json._id = json.id;
        delete json.id;
      }
      this.ajax(encodeURIComponent(json._id || ''), json._id ? 'PUT' : 'POST', {
        data: json,
        context: this,
        success: function(data) {
          data = $.extend(json, data); 
          this.get('serializer').addHasManyRelationships(data, record);
          store.didSaveRecord(record, data);
        }
      });
    },

    updateRecord: function(store, type, record) {
      var json = record.toJSON({ includeId: true });
      json._id = json.id;
      json._rev = record.get('data.attributes.rev');
      delete json.id;
      this.ajax(encodeURIComponent(json._id), 'PUT', {
        data: json,
        context: this,
        success: function(data) {
          data = $.extend(json, data); 
          this.get('serializer').addHasManyRelationships(data, record);
          store.didSaveRecord(record, data);
        }
      });
    },

    deleteRecord: function(store, type, record) {
      if (record.get('data.attributes._remote_deleted')) {
        store.didDeleteRecord(record); // fire and forget...
      } else {
        this.ajax(encodeURIComponent(record.get('id')) + '?rev=' + record.get('data.attributes.rev'), 'DELETE', {
          context: this,
          success: function(data) {
            store.didSaveRecord(record);
          }
        });
      }
    },
    
    cachedRecordForId: function(store, id) {
      // TODO fix this, as it's accessing private properties of Ember Data
      for (var key in store.clientIdToId) {
        if (store.clientIdToId.hasOwnProperty(key) && store.clientIdToId[key] == id) {
          return store.recordCache[key];
        }
      }
      return null;
    },
    
    processChange: function(store, change){
      var type, metaAttribute = this.get('metaAttribute'),
        record = this.cachedRecordForId(store, change.id);
        
      if (record && change.deleted) {
        // a record has remotely been deleted
        if (record.get('isDirty')) {
          if (!record.get('isDeleted')) {
            // TODO fix this conflict case
            record.onRemoteDeleteConflict(change);
          }
        } else {
          record.remoteDeleteRecord(change);
        }
      } else if (change.doc && change.doc[metaAttribute] && typeof change.doc[metaAttribute].type === 'string') { 
        // a record has remotely been added/edited
        type = Ember.get(window, change.doc[metaAttribute].type);
      
        // fix _id and _rev data
        change.doc.id = change.doc._id;
        change.doc.rev = change.doc._rev;
        delete change.doc._id;
        delete change.doc._rev;

        if (record) {
          // we have this record in memory, so update the contents
          if (record.get('isDirty')) {
            // TODO fix this conflict case
            record.onRemoteUpdateConflict(change);
          } else {
            // if it's not the object we just saved ourselves
            // reload the object, with the current relations copied
            if (record.get('data.attributes.rev') != change.changes[0].rev) {
              record.remoteUpdateRecord(change);
            }
          }
        } else {
          // if a record array for this type exists, then always load the object
          if (store.typeMapFor(type).recordArrays.length > 0) {
            store.load(type, change.doc);
            record = store.find(type, change.id);
          } else {
            // otherwise, see if it references known records, if so, load
            var self = this;
            (change.doc[metaAttribute].belongsTo || []).forEach(function(key) {
              if (!record && self.cachedRecordForId(store, change.doc[key])) {
                // an associated record is loaded in the cache, so load this record
                store.load(type, change.doc);
                record = store.find(type, change.id);
              }
            });
          }          
        }
      }
    },
    
    processChanges: function(store){
      var self = this;
      return function(data) {
        data.results.forEach(function(row){
          self.processChange(store, row);
        });
      };
    },
    
    monitorChanges: function(since, options) {
      // kindly borrowed from jquery couch, from Futon
    
      var rootUrl = '/%@/'.fmt(this.get('db'));
      /**
       * @namespace
       * $.couch.db.changes provides an API for subscribing to the changes
       * feed
       * <pre><code>var $changes = $.couch.db("mydatabase").changes();
       *$changes.onChange = function (data) {
       *    ... process data ...
       * }
       * $changes.stop();
       * </code></pre>
       */
          // Convert a options object to an url query string.
          // ex: {key:'value',key2:'value2'} becomes '?key="value"&key2="value2"'
          function encodeOptions(options) {
            var buf = [];
            if (typeof(options) === "object" && options !== null) {
              for (var name in options) {
                if ($.inArray(name,
                              ["error", "success", "beforeSuccess", "ajaxStart"]) >= 0)
                  continue;
                var value = options[name];
                if ($.inArray(name, ["key", "startkey", "endkey"]) >= 0) {
                  value = toJSON(value);
                }
                buf.push(encodeURIComponent(name) + "=" + encodeURIComponent(value));
              }
            }
            return buf.length ? "?" + buf.join("&") : "";
          }
          function ajax(obj, options, errorMessage, ajaxOptions) {

            var defaultAjaxOpts = {
              contentType: "application/json",
              headers:{"Accept": "application/json"}
            };

            options = $.extend({successStatus: 200}, options);
            ajaxOptions = $.extend(defaultAjaxOpts, ajaxOptions);
            errorMessage = errorMessage || "Unknown error";
            $.ajax($.extend($.extend({
              type: "GET", dataType: "json", cache : !$.browser.msie,
              beforeSend: function(xhr){
                if(ajaxOptions && ajaxOptions.headers){
                  for (var header in ajaxOptions.headers){
                    xhr.setRequestHeader(header, ajaxOptions.headers[header]);
                  }
                }
              },
              complete: function(req) {
                try {
                  var resp = $.parseJSON(req.responseText);
                } catch(e) {
                  if (options.error) {
                    options.error(req.status, req, e);
                  } else {
                    throw errorMessage + ': ' + e;
                  }
                  return;
                }
                if (options.ajaxStart) {
                  options.ajaxStart(resp);
                }
                if (req.status == options.successStatus) {
                  if (options.beforeSuccess) options.beforeSuccess(req, resp);
                  if (options.success) options.success(resp);
                } else if (options.error) {
                  options.error(req.status, resp && resp.error ||
                                errorMessage, resp && resp.reason || "no response");
                } else {
                  throw errorMessage + ": " + resp.reason;
                }
              }
            }, obj), ajaxOptions));
          }
      
        options = options || {};
        // set up the promise object within a closure for this handler
        var timeout = 100, db = this, active = true,
          listeners = [],
          promise = /** @lends $.couch.db.changes */ {
            /**
             * Add a listener callback
             * @see <a href="http://techzone.couchbase.com/sites/default/
             * files/uploads/all/documentation/couchbase-api-db.html#couch
             * base-api-db_db-changes_get">docs for /db/_changes</a>
             * @param {Function} fun Callback function to run when
             * notified of changes.
             */
          onChange : function(fun) {
            listeners.push(fun);
          },
            /**
             * Stop subscribing to the changes feed
             */
          stop : function() {
            active = false;
          }
        };
        // call each listener when there is a change
        function triggerListeners(resp) {
          $.each(listeners, function() {
            this(resp);
          });
        };
        // when there is a change, call any listeners, then check for
        // another change
        options.success = function(resp) {
          timeout = 100;
          if (active) {
            since = resp.last_seq;
            triggerListeners(resp);
            getChangesSince();
          };
        };
        options.error = function() {
          if (active) {
            setTimeout(getChangesSince, timeout);
            timeout = timeout * 2;
          }
        };
        // actually make the changes request
        function getChangesSince() {
          var opts = $.extend({heartbeat : 10 * 1000}, options, {
            feed : "longpoll",
            since : since,
            include_docs : true 
          });
          ajax(
            {url: rootUrl + "_changes"+encodeOptions(opts)},
            options,
            "Error connecting to "+rootUrl+"/_changes."
          );
        }
        // start the first request
        if (since) {
          getChangesSince();
        } else {
          ajax(
            {url: rootUrl},
            {
              success : function(info) {
                since = info.update_seq;
                getChangesSince();
              }
            },
            "Database information could not be retrieved"
          );
        }
        return promise;
    }
    
  });
})();