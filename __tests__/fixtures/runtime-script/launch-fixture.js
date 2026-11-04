module.exports = String.raw`(function() {
  window._satellite = window._satellite || {};
  window._satellite.container = {
  "buildInfo": {
    "turbineVersion": "29.1.0",
    "turbineBuildDate": "2026-06-04T00:00:00Z",
    "buildDate": "2026-11-01T10:00:00Z"
  },
  "environment": {
    "id": "EN00000000000000000000000000000003",
    "stage": "production"
  },
  "dataElements": {
    "Page Title": {
      "modulePath": "core/src/lib/dataElements/customCode.js",
      "settings": {
        "source": function(event) {
  return document.title;
}
      }
    },
    "Site Section": {
      "defaultValue": "home",
      "forceLowerCase": true,
      "modulePath": "core/src/lib/dataElements/javascriptVariable.js",
      "settings": {
        "path": "site.section"
      }
    }
  },
  "extensions": {
    "core": {
      "displayName": "Core",
      "hostedLibFilesBaseUrl": "https://assets.adobedtm.com/extensions/EP00000000000000000000000000000001/",
      "modules": {
        "core/src/lib/dataElements/customCode.js": {
          "name": "custom-code",
          "displayName": "Custom Code",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings, event) { return settings.source(event); };
          }

        },
        "core/src/lib/dataElements/javascriptVariable.js": {
          "name": "javascript-variable",
          "displayName": "JavaScript Variable",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings) { return settings.path; };
          }

        },
        "core/src/lib/events/libraryLoaded.js": {
          "name": "library-loaded",
          "displayName": "Library Loaded (Page Top)",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings, trigger) { trigger(); };
          }

        },
        "core/src/lib/events/domReady.js": {
          "name": "dom-ready",
          "displayName": "DOM Ready",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings, trigger) { trigger(); };
          }

        },
        "core/src/lib/conditions/path.js": {
          "name": "path",
          "displayName": "Path Without Query String",
          "script": function(module, exports, require, turbine) {
module.exports = function () { return true; };
          }

        },
        "core/src/lib/actions/customCode.js": {
          "name": "custom-code",
          "displayName": "Custom Code",
          "script": function(module, exports, require, turbine) {
module.exports = function () {};
          }

        },
        "core/src/lib/helpers/once.js": {
          "script": function(module, exports, require, turbine) {
module.exports = function (fn) { return fn; };
          }

        }
      }
    }
  },
  "company": {
    "orgId": "00000000000000000000000A@AdobeOrg",
    "dynamicCdnEnabled": false
  },
  "property": {
    "name": "Fixture Property",
    "settings": {
      "domains": [
        "example.com"
      ],
      "undefinedVarsReturnEmpty": false,
      "ruleComponentSequencingEnabled": true
    },
    "id": "PR00000000000000000000000000000001"
  },
  "rules": [
    {
      "id": "RL00000000000000000000000000000011",
      "name": "Load",
      "events": [
        {
          "modulePath": "core/src/lib/events/libraryLoaded.js",
          "settings": {},
          "ruleOrder": 50.0
        }
      ],
      "conditions": [],
      "actions": [
        {
          "modulePath": "core/src/lib/actions/customCode.js",
          "settings": {
            "source": "console.log(\"inline\");",
            "language": "javascript"
          }
        }
      ]
    },
    {
      "id": "RL00000000000000000000000000000012",
      "name": "Click",
      "events": [
        {
          "modulePath": "core/src/lib/events/domReady.js",
          "settings": {},
          "ruleOrder": 50.0
        }
      ],
      "conditions": [
        {
          "modulePath": "core/src/lib/conditions/path.js",
          "settings": {
            "paths": [
              {
                "value": "/checkout"
              }
            ]
          },
          "negate": true,
          "timeout": 2000
        }
      ],
      "actions": [
        {
          "modulePath": "core/src/lib/actions/customCode.js",
          "settings": {
            "source": 'https://assets.adobedtm.com/0000aaaa/1111bbbb/a1b2c3d4e5f6/RC00000000000000000000000000000022-source.js',
            "language": "javascript",
            "isExternal": true
          },
          "timeout": 2000,
          "delayNext": true
        }
      ]
    }
  ]
}
})();

var _satellite = (function () {
	'use strict';
	return {};
})();
`;
