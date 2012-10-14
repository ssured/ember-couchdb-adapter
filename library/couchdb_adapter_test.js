Ember.ENV.TESTING = true;

var get = Ember.get;
var set = Ember.set;

var adapter;
var store;
var ajaxUrl;
var ajaxType;
var ajaxHash;

var person;
var Person, Article, Tag;

var expectUrl = function(url, desc) {
  equal(ajaxUrl, url, "the URL is " + desc);
};

var expectType = function(type) {
  equal(ajaxType, type, "the HTTP method is " + type);
};

var expectData = function(hash) {
  deepEqual(ajaxHash.data, hash, "the hash was passed along");
};

var expectState = function(state, value, p) {
  p = p || person;

  if (value === undefined) {
    value = true;
  }

  var flag = "is" + state.charAt(0).toUpperCase() + state.substr(1);
  equal(get(p, flag), value, "the state is " + (value === false ? "not ": "") + state);
};

module("CouchDBAdapter", {
  setup: function() {
    adapter = DS.CouchDBAdapter.create({
      db: 'DB_NAME',
      designDoc: 'DESIGN_DOC',
      _ajax: function(url, type, hash) {
        var success = hash.success,
        self = this;

        ajaxUrl = url;
        ajaxType = type;
        ajaxHash = hash;

        if (success) {
          hash.success = function(json) {
            success.call(self, json);
          };
        }
      }
    });

    store = DS.Store.create({
      adapter: adapter
    });

    Person = DS.Model.extend({
      name: DS.attr('string')
    });
    Person.toString = function() { return 'Person'; };

    Tag = DS.Model.extend({
      label: DS.attr('string')
    });
    Tag.toString = function() { return 'Tag'; };

    Article = DS.Model.extend({
      label: DS.attr('string')
    });
    Article.toString = function() { return 'Article'; };
    
    // setup relationships
    Person.reopen({
      articles: DS.hasMany(Article)
    });
    Tag.reopen({
      article: DS.belongsTo(Article)
    });
    Article.reopen({
      writer: DS.belongsTo(Person),
      tags: DS.hasMany(Tag)
    });
  },

  teardown: function() {
    adapter.destroy();
    store.destroy();
  }
});

test("is defined", function() {
  ok(DS.CouchDBAdapter !== undefined, "DS.CouchDBAdapter is undefined");
});

test("is a subclass of DS.Adapter", function() {
  ok(DS.Adapter.detect(DS.CouchDBAdapter), "CouchDBAdapter is a subclass of DS.Adapter");
});

test("stringForType by default returns the value of toString", function() {
  equal(adapter.stringForType(Person), 'Person');
});

test("finding a tag makes a GET to /DB_NAME/:id", function() {
  var tag = store.find(Tag, 'a');
  
  expectState('loaded', false, tag);
  expectUrl('/DB_NAME/a');
  expectType('GET');

  ajaxHash.success({
    _id: 'a',
    _rev: 'abc',
    label: 'Hansi Hinterseer'
  });

  expectState('loaded', true, tag);
  expectState('dirty', false, tag);
  equal(tag.get('id'), 'a');
  equal(tag.get('data.attributes.rev'), 'abc');
  equal(tag.get('label'), 'Hansi Hinterseer');
});

test("check setup of associations", function(){
  person = store.find(Person, 'a');
  deepEqual(Ember.get(person.constructor, 'associationNames.hasMany'), ['articles'], 'Person has articles as the only hasMany association');
  
  equal(Person.typeForAssociation('articles'), Article, 'articles attribute point to Article type');
  
  deepEqual(Ember.get(Article, 'associationNames'), {
    belongsTo: ['writer'],
    hasMany: ['tags']
  }, 'Articles have two associations');
  
  deepEqual(Ember.get(Article, 'associationsByName').get('writer'), {
    isAssociation: true,
    key: 'writer',
    kind: 'belongsTo',
    options: {},
    type: Person
  }, 'Articles have two associations');
  
  var foreignType = DS.inverseTypeFor(Person, 'articles');
  equal(foreignType, Article, 'Articles attribute points to Article objects');
  
  var foreignName = DS.inverseNameFor(Article, Person, 'belongsTo');
  equal(foreignName, 'writer', 'Articles point to Person in the writer attribute');
});

test("finding a person makes a GET to /DB_NAME/:id and queries associations", function() {
  person = store.find(Person, 'a');
  
  expectState('loaded', false);
  expectUrl('/DB_NAME/a');
  expectType('GET');

  ajaxHash.success({
    _id: 'a',
    _rev: 'abc',
    name: 'Hansi Hinterseer'
  });

  expectUrl('/DB_NAME/_design/DESIGN_DOC/_view/by-ember-association', 'the association view');
  expectType('POST');
  expectData({
    keys: ["a"]
  });

  ajaxHash.success({
    rows: []
  });

  expectState('loaded', true);
  expectState('dirty', false);
  equal(person.get('id'), 'a');
  equal(person.get('data.attributes.rev'), 'abc');
  equal(person.get('name'), 'Hansi Hinterseer');
});

test("creating a person makes a POST to /DB_NAME with data hash", function() {
  person = store.createRecord(Person, {
    name: 'Tobias Fünke'
  });

  expectState('new');
  store.commit();
  expectState('saving');

  expectUrl('/DB_NAME/', 'the database name');
  expectType('POST');
  expectData({
    name: "Tobias Fünke",
    ember_data: {type:'Person'},
  });

  ajaxHash.success({
    ok: true,
    id: "abc",
    rev: "1-abc"
  });
  expectState('saving', false);
  expectState('loaded', true);
  expectState('dirty', false);

  equal(person, store.find(Person, 'abc'), "it's possible to find the person by the returned ID");
  equal(get(person, 'data.attributes.rev'), '1-abc', "the revision is stored on the data");
});

test("creating a person with explicit ID makes a PUT to /DB_NAME with data hash", function() {
  person = store.createRecord(Person, {
    id: 'p1',
    name: 'Tobias Fünke'
  });

  expectState('new');
  store.commit();
  expectState('saving');

  expectUrl('/DB_NAME/p1', 'the database name');
  expectType('PUT');
  expectData({
    _id: "p1",
    name: "Tobias Fünke",
    ember_data: {type:'Person'},
  });

  ajaxHash.success({
    ok: true,
    id: "p1",
    rev: "1-abc"
  });
  expectState('saving', false);
  expectState('loaded', true);
  expectState('dirty', false);

  equal(person, store.find(Person, 'p1'), "it's possible to find the person by the returned ID");
  equal(get(person, 'data.attributes.rev'), '1-abc', "the revision is stored on the data");
});

test("updating a person makes a PUT to /DB_NAME/:id with data hash", function() {
  store.load(Person, {
    id: 'abc',
    rev: '1-abc',
    name: 'Tobias Fünke'
  });

  person = store.find(Person, 'abc');

  expectState('new', false);
  expectState('loaded');
  expectState('dirty', false);

  set(person, 'name', 'Nelly Fünke');

  expectState('dirty');
  store.commit();

  expectUrl('/DB_NAME/abc', 'the database name with the record ID');
  expectType('PUT');
  expectData({
    "_id": "abc",
    "_rev": "1-abc",
    ember_data: {type:'Person'},
    name: "Nelly Fünke"
  });

  ajaxHash.success({
    ok: true,
    id: 'abc',
    rev: '2-def'
  });

  expectState('saving', false);
  expectState('loaded', true);
  expectState('dirty', false);

  equal(person, store.find(Person, 'abc'), "the same person is retrieved by the same ID");
  equal(get(person, 'name'), 'Nelly Fünke', "the data is preserved");
  equal(get(person, 'data.attributes.rev'), '2-def', "the revision is updated");
});

test("deleting a person makes a DELETE to /DB_NAME/:id", function() {
  store.load(Person, {
    id: 'abc',
    rev: '1-abc',
    name: "Tobias Fünke"
  });

  person = store.find(Person, "abc");

  expectState('new', false);
  expectState('loaded');
  expectState('dirty', false);

  person.deleteRecord();

  expectState('dirty');
  expectState('deleted');
  store.commit();
  expectState('saving');

  expectUrl("/DB_NAME/abc?rev=1-abc", "the database name with the record ID and rev as parameter");
  expectType("DELETE");

  ajaxHash.success({
    ok: true,
    rev: '2-abc'
  });
  expectState('deleted');
});

test("findMany makes a POST to /DB_NAME/_all_docs?include_docs=true", function() {
  var tags = store.findMany(Tag, ['a', 'b']);

  expectUrl('/DB_NAME/_all_docs?include_docs=true');
  expectType('POST');
  expectData({
    keys: ['a', 'b']
  });

  ajaxHash.success({
    rows: [{
      doc: { _id: 'a', _rev: 'abc', label: 'first'}
    }, {
      doc: { _id: 'b', _rev: 'def', label: 'second'}
    }]
  });

  equal(store.find(Tag, 'a').get('label'), 'first');
  equal(store.find(Tag, 'a').get('data.attributes.rev'), 'abc');
                   
  equal(store.find(Tag, 'b').get('label'), 'second');
  equal(store.find(Tag, 'b').get('data.attributes.rev'), 'def');
});

test("findAll makes a GET to /DB_NAME/_design/DESIGN_DOC/_view/by-ember-type", function() {
  var allTags = store.findAll(Tag);

  expectUrl('/DB_NAME/_design/DESIGN_DOC/_view/by-ember-type?include_docs=true&key="Tag"');
  expectType('GET');
  equal(allTags.get('length'), 0);

  ajaxHash.success({
    rows: [
      { doc: { _id: 'a', _rev: 'a', label: 'first' } },
      { doc: { _id: 'b', _rev: 'b', label: 'second' } },
      { doc: { _id: 'c', _rev: 'c', label: 'third' } }
    ]
  });

  equal(allTags.get('length'), 3);

  equal(store.find(Tag, 'a').get('label'), 'first');
  equal(store.find(Tag, 'a').get('data.attributes.rev'), 'a');

  equal(store.find(Tag, 'b').get('label'), 'second');
  equal(store.find(Tag, 'b').get('data.attributes.rev'), 'b');

  equal(store.find(Tag, 'c').get('label'), 'third');
  equal(store.find(Tag, 'c').get('data.attributes.rev'), 'c');
});

test("findAll calls viewForType if useCustomTypeLookup is set to true", function() {
  expect(2);

  adapter.set('customTypeLookup', true);
  adapter.reopen({
    viewForType: function(type, viewParams) {
      equal(type, Person);
      ok(viewParams);
    }
  });

  store.findAll(Person);
});

test("findAll does a GET to view name returned by viewForType if useCustomTypeLookup is set to true", function() {
  adapter.set('customTypeLookup', true);
  adapter.reopen({
    viewForType: function(type, viewParams) {
      equal(typeof viewParams, 'object', 'viewParams is an object');
      viewParams.key = "myTagKey";
      viewParams.include_docs = false;
      return 'myTagView';
    }
  });

  var allTags = store.findAll(Tag);

  expectUrl('/DB_NAME/_design/DESIGN_DOC/_view/myTagView');
  expectType('GET');
  expectData({
    key: 'myTagKey',
    include_docs: true // include_docs is overridden
  });

  ajaxHash.success({
    rows: [
      { doc: { _id: 1, _rev: 'a', label: 'first' } },
      { doc: { _id: 2, _rev: 'b', label: 'second' } },
      { doc: { _id: 3, _rev: 'c', label: 'third' } }
    ]
  });

  equal(allTags.get('length'), 3);

  equal(store.find(Tag, 1).get('label'), 'first');
  equal(store.find(Tag, 1).get('data.attributes.rev'), 'a');
  equal(store.find(Tag, 2).get('label'), 'second');
  equal(store.find(Tag, 2).get('data.attributes.rev'), 'b');
  equal(store.find(Tag, 3).get('label'), 'third');
  equal(store.find(Tag, 3).get('data.attributes.rev'), 'c');
});

test("a view is requested via findQuery of type 'view'", function() {
  var persons = store.findQuery(Person, {
    type: 'view',
    viewName: 'PERSONS_VIEW'
  });

  expectUrl('/DB_NAME/_design/DESIGN_DOC/_view/PERSONS_VIEW');
  expectType('GET');
});

test("a view adds the query options as parameters", function() {
  var persons = store.findQuery(Person, {
    type: 'view',
    viewName: 'PERSONS_VIEW',
    options: {
      keys: ['a', 'b'],
      limit: 10,
      skip: 42
    }
  });

  expectUrl('/DB_NAME/_design/DESIGN_DOC/_view/PERSONS_VIEW');
  expectType('GET');
  expectData({
    keys: ['a', 'b'],
    limit: 10,
    skip: 42
  });
});

test("hasMany relationship loads from CouchDB view", function() {
  store.load(Article, {id: 'a1', rev: 't1rev', label: 'tag 1', writer: 'p'});
  store.load(Article, {id: 'a2', rev: 't2rev', label: 'tag 2', writer: 'p'});
  
  person = store.find(Person, 'p');
  
  expectState('loaded', false);
  expectUrl('/DB_NAME/p');
  expectType('GET');

  ajaxHash.success({
    _id: 'p',
    _rev: 'abc',
    name: 'Hansi Hinterseer'
  });

  expectUrl('/DB_NAME/_design/DESIGN_DOC/_view/by-ember-association', 'the association view');
  expectType('POST');
  expectData({
    keys: ["p"]
  });

  ajaxHash.success({
      rows: [
        { id:'a1', key:'p', value:'Article'},
        { id:'a2', key:'p', value:'Article'}
      ]
  });

  expectState('loaded', true);
  expectState('dirty', false);
  equal(person.get('id'), 'p');
  equal(person.get('data.attributes.rev'), 'abc');
  equal(person.get('articles.length'), 2);
});

test("hasMany relationship saves to CouchDB view", function() {
  store.load(Tag, {id: 't1', rev: 't1rev', label: 'tag 1', article: 'a1'});
  store.load(Tag, {id: 't2', rev: 't2rev', label: 'tag 2', article: 'a1'});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', tags:['t1','t2']});

  var article = store.find(Article, 'a1');
  
  expectState('loaded', true, article);
  expectState('dirty', false, article);
  equal(article.get('tags.length'), 2);
  
  // change some value on the owner
  article.set('label', 'ARTICLE');
  expectState('dirty', true, article);

  store.commit();
  expectUrl('/DB_NAME/a1');
  expectType('PUT');
  expectData({
    _id: 'a1',
    _rev: 'a1rev',
    label: 'ARTICLE',
    ember_data: {type: 'Article', belongsTo:['writer']},
    writer: null
  });
  
  ajaxHash.success({
    ok: 'true',
    id: 'a1',
    rev: 'a1rev2'
  });
  expectState('dirty', false, article);
  equal(article.get('tags.length'), 2, 'Article still contains the same amount of tags after updating');
});

test("hasMany relationship dirties only child if child is added", function() {
  store.load(Tag, {id: 't1', rev: 't1rev', label: 'tag 1', article: 'a1'});
  store.load(Tag, {id: 't2', rev: 't2rev', label: 'tag 2', article: null});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', tags:['t1']});

  var article = store.find(Article, 'a1');
  ok(article);
  equal(article.get('tags.length'), 1);
  expectState('dirty', false, article);

  var t2 = store.find(Tag, 't2');
  ok(t2);
  article.get('tags').addObject(t2);

  equal(article.get('tags.length'), 2, 'The article now holds 2 tags');
  expectState('dirty', false, article);
  expectState('dirty', true, t2);

  store.commit();

  expectUrl('/DB_NAME/t2');
  expectType('PUT');
  expectData({
    _id: "t2",
    _rev: "t2rev",
    ember_data: {type: 'Tag', belongsTo:['article']},
    label: "tag 2",
    article: 'a1'
  });

  ajaxHash.success({
    ok: true,
    id: 't2',
    rev: 't2rev2'
  });

  equal(t2.get('data.attributes.rev'), 't2rev2');
});

test("hasMany relationship doesn't dirty parent if child is removed", function() {
  store.load(Tag, {id: 't1', rev: 't1rev', label: 'tag 1', article: 'a1'});
  store.load(Tag, {id: 't2', rev: 't2rev', label: 'tag 2', article: 'a1'});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', tags: ['t1', 't2']});

  var article = store.find(Article, 'a1');
  ok(article);
  equal(article.get('tags.length'), 2);
  expectState('dirty', false, article);

  var t2 = store.find(Tag, 't2');
  ok(t2);
  article.get('tags').removeObject(t2);

  equal(article.get('tags.length'), 1);
  expectState('dirty', false, article);
  expectState('dirty', true, t2);

  store.commit();

  expectUrl('/DB_NAME/t2');
  expectType('PUT');
  expectData({
    "_id": "t2",
    "_rev": "t2rev",
    ember_data: {type:'Tag', belongsTo:['article']},
    label: "tag 2",
    article: null
  });

  ajaxHash.success({
    ok: true,
    id: 't2',
    rev: 't2rev2'
  });

  expectState('dirty', false, t2);
  equal(t2.get('data.attributes.rev'), 't2rev2');
});

test("hasMany relationship doesn't dirty parent if child is deleted", function() {
  store.load(Tag, {id: 't1', rev: 't1rev', label: 'tag 1', article: 'a1'});
  store.load(Tag, {id: 't2', rev: 't2rev', label: 'tag 2', article: 'a1'});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', tags: ['t1', 't2']});

  var article = store.find(Article, 'a1');
  ok(article);
  equal(article.get('tags.length'), 2);
  expectState('dirty', false, article);

  var t2 = store.find(Tag, 't2');
  ok(t2);
  t2.deleteRecord();

  equal(article.get('tags.length'), 1);
  expectState('dirty', false, article);
  expectState('dirty', true, t2);
  expectState('deleted', true, t2);

  store.commit();

  expectUrl('/DB_NAME/t2?rev=t2rev');
  expectType('DELETE');
  expectData(undefined);

  ajaxHash.success({
    ok: true,
    rev: 't2rev2'
  });

  expectState('dirty', false, t2);
  expectState('deleted', true, t2);
  equal(t2.get('data.attributes.rev'), 't2rev');
});

test("hasMany relationship dirties child if child is updated", function() {
  store.load(Tag, {id: 't1', rev: 't1rev', label: 'tag 1', article: 'a1'});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', tags: ['t1']});

  var article = store.find(Article, 'a1');
  var tag = store.find(Tag, 't1');
  ok(tag);
  expectState('dirty', false, tag);

  tag.set('label', 'tag 1 updated');

  expectState('dirty', false, article);
  expectState('dirty', true, tag);

  store.commit();

  expectUrl('/DB_NAME/t1');
  expectType('PUT');
  expectData({
    "_id": "t1",
    "_rev": "t1rev",
    ember_data: {type: 'Tag', belongsTo:['article']},
    article: 'a1',
    label: "tag 1 updated"
  });

  ajaxHash.success({
    ok: true,
    id: 't1',
    rev: 't1rev2'
  });

  expectState('dirty', false, tag);
  equal(tag.get('data.attributes.rev'), 't1rev2');  
});

test("belongsTo relationship dirties if item is deleted", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: ['a1']});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', writer: 'p1'});

  var article = store.find(Article, 'a1');
  var person = store.find(Person, 'p1');
  ok(article);
  ok(person);
  expectState('dirty', false, article);
  expectState('dirty', false, person);
  
  equal(person.get('articles.length'), 1, "Found 1 article");

  article.set('writer', null);

  equal(person.get('articles.length'), 0, "No articles exist after deletion");
  
  expectState('dirty', false, person);
  expectState('dirty', true, article);

  store.commit();

  expectUrl('/DB_NAME/a1');
  expectType('PUT');
  expectData({
    "_id": "a1",
    "_rev": "a1rev",
    ember_data: {type: 'Article', belongsTo: ['writer']},
    writer: null,
    label: "article"
  });

  ajaxHash.success({
    ok: true,
    id: 'a1',
    rev: 'a1rev2'
  });

  expectState('dirty', false, article);
  equal(article.get('data.attributes.rev'), 'a1rev2');  
  
});

test("belongsTo relationship dirties item if item is updted", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: ['a1']});
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', writer: 'p1'});

  var article = store.find(Article, 'a1');
  var person = store.find(Person, 'p1');
  ok(article);
  ok(person);
  expectState('dirty', false, article);
  expectState('dirty', false, person);

  person.set('name', 'updated writer');

  expectState('dirty', true, person);
  expectState('dirty', false, article);

  store.commit();

  expectUrl('/DB_NAME/p1');
  expectType('PUT');
  expectData({
    "_id": "p1",
    "_rev": "p1rev",
    ember_data: {type: 'Person'},
    name: "updated writer"
  });

  ajaxHash.success({
    ok: true,
    id: 'p1',
    rev: 'p1rev2'
  });

  expectState('dirty', false, person);
  equal(person.get('data.attributes.rev'), 'p1rev2');  
});

test("Fetching cached records", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(adapter.cachedRecordForId(store, 'p1'));
  equal(adapter.cachedRecordForId(store, 'p1').get('id'), 'p1', 'Ember Data cache can be accessed');
});

test("Remote update of a record", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(person);
  equal(person.get('name'), 'author', 'Name is author');
  expectState('dirty', false, person);
  
  adapter.processChange(store, {
    id: 'p1',
    changes: [
      { rev: 'p1rev2'}
    ],
    doc: {
      _id: 'p1', 
      _rev: 'p1rev2', 
      name: 'AUTHOR', 
      articles: [],
      ember_data: {type: 'Person', belongsTo:[] }
    }
  });
  
  expectState('dirty', false, person);
  equal(person.get('name'), 'AUTHOR', 'Name is remotely capitalized');
});

test("Remote deletion of a record", function() {
  ajaxHash = "no change";
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(person);
  expectState('dirty', false, person);
  expectState('deleted', false, person);
  
  adapter.processChange(store, {
    id: 'p1',
    changes: [
      { rev: 'p1rev2'}
    ],
    deleted: true
  });
  
  expectState('dirty', false, person);
  expectState('deleted', true, person);
  equal(ajaxHash, "no change", 'Remote deletion does not talk to the server');
});

test("Loading an associated record, creates the association", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(person);
  expectState('dirty', false, person);
  equal(person.get('articles.length'), 0, 'Person did not write any articles yet');
  
  store.load(Article, {id: 'a1', rev: 'a1rev', label: 'article', writer: 'p1'});
  expectState('dirty', false, person);
  equal(person.get('articles.length'), 1, 'Person got one remote article');

  var article = store.find(Article, 'a1');
  expectState('dirty', false, article);
  equal(article.get('writer.name'), 'author', 'The article references the person');
});

test("Creating an associated record, updates the association", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(person);
  expectState('dirty', false, person);
  equal(person.get('articles.length'), 0, 'Person did not write any articles yet');
  
  var article = Article.createRecord({id: 'a1', label:'article', writer: person});      // this statement fails
  // article.set('writer', person);                                                     // this statement succeeds
  expectState('dirty', false, person);
  expectState('dirty', true, article);
  equal(article.get('writer.name'), 'author', 'The article references the person');
  equal(person.get('articles.length'), 1, 'Person got one remote article');
});
test("Remote creation of an associated record", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(person);
  expectState('dirty', false, person);
  equal(person.get('articles.length'), 0, 'Person did not write any articles yet');
  
  adapter.processChange(store, {
    id: 'a1',
    changes: [
      { rev: 'a1rev'}
    ],
    doc: {
      _id: 'a1', 
      _rev: 'a1rev', 
      label: 'article',
      writer: 'p1',
      ember_data: {type: 'Article', belongsTo:['writer'] }
    }
  });
  
  expectState('dirty', false, person);
  equal(person.get('articles.length'), 1, 'Person got one remote article');
});
test("Remote deletion of a locally deleted record", function() {
  store.load(Person, {id: 'p1', rev: 'p1rev', name: 'author', articles: []});
  var person = store.find(Person, 'p1');
  ok(person);
  expectState('dirty', false, person);
  expectState('deleted', false, person);
  person.deleteRecord();
  expectState('dirty', true, person);
  expectState('deleted', true, person);
  store.commit();

  expectUrl('/DB_NAME/p1?rev=p1rev');
  expectType('DELETE');
  ajaxHash.success({
    ok: true,
    rev: 'p1rev2'
  });

  expectState('dirty', false, person);
  expectState('deleted', true, person);
    
  adapter.processChange(store, {
    id: 'p1',
    changes: [
      { rev: 'p1rev2'}
    ],
    doc: {
      _id: 'p1', 
      _rev: 'p1rev2',
      deleted: true 
    }
  });

  expectState('dirty', false, person);
  expectState('deleted', true, person);
});
