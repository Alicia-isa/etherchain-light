var express = require('express');
var router = express.Router();

var async = require('async');
var Web3 = require('web3');

var wabt = require('wabt');

var EWASM_BYTES = '0x0061736d01';

function hex2buf (hex) {
  let typedArray = new Uint8Array(hex.match(/[\da-f]{2}/gi).map(function (h) {
    return parseInt(h, 16);
  }));
  return typedArray;
}

function wasm2wast(wasmBytecode) {
  let wasmBuf = hex2buf(wasmBytecode);
  let textmodule = wabt.readWasm(wasmBuf, {readDebugNames: true});
  textmodule.generateNames();
  textmodule.applyNames();
  let wasmAsWast = textmodule.toText({foldExprs: true, inlineExport: true});
  return wasmAsWast;
}

router.get('/:account', function(req, res, next) {
  
  var config = req.app.get('config');  
  var web3 = new Web3();
  web3.setProvider(config.provider);
  
  var db = req.app.get('db');

  var data = {};
  var BLOCK_COUNT = 1000;

  async.waterfall([
    function(callback) {
      web3.eth.getBlock("latest", false, function(err, result) {
        callback(err, result);
      });
    }, function(lastBlock, callback) {
      data.lastBlock = lastBlock.number;
      data.lastBlockHash = lastBlock.hash;
      //limits the from block to -1000 blocks ago if block count is greater than 1000
      if (data.lastBlock > BLOCK_COUNT) {
        data.fromBlock = data.lastBlock - BLOCK_COUNT;
      } else {
        data.fromBlock = 0x00;
      }
      web3.eth.getBalance(req.params.account, function(err, balance) {
        callback(err, balance);
      });
    }, function(balance, callback) {
      data.balance = balance;
      web3.eth.getCode(req.params.account, function(err, code) {
        callback(err, code);
      });
    }, function(code, callback) {
      data.code = code;
      data.wast = "";
      if (code !== "0x") {
        data.isContract = true;

        // do code to wast conversion here
        if (code.substring(0,12) === EWASM_BYTES) {
          var wast = wasm2wast(code.substr(2));
          data.wast = wast;
        }

        web3.debug.storageRangeAt(data.lastBlockHash, 0, req.params.account, '0x00', 1000, function(err, result) {
          if (err) {
            callback(err);
          } else {
            callback(null, result.storage);
          }
        })
      } else {
        callback(null, null);
      }
   }, function(storage, callback) {
      if (storage) {
        var listOfStorageKeyVals = Object.values(storage);
        data.storage = listOfStorageKeyVals;
      }

      // fetch verified contract source from db      
      db.get(req.params.account.toLowerCase(), function(err, value) {
        callback(null, value);
      });
    }, function(source, callback) {
      
      if (source) {
        data.source = JSON.parse(source);
        
        data.contractState = [];
        if (!data.source.abi) {
          return callback();
        }
        var abi = JSON.parse(data.source.abi);
        var contract = web3.eth.contract(abi).at(req.params.account);
        
        
        async.eachSeries(abi, function(item, eachCallback) {
          if (item.type === "function" && item.inputs.length === 0 && item.constant) {
            try {
              contract[item.name](function(err, result) {
                data.contractState.push({ name: item.name, result: result });
                eachCallback();
              });
            } catch(e) {
              console.log(e);
              eachCallback();
            }
          } else {
            eachCallback();
          }
        }, function(err) {
          callback(err);
        });
        
      } else {
        callback();
      }
      
      
    }, function(callback) {
      var blocks = [];
 
      var blockCount = BLOCK_COUNT;
      var traces = [];

      if (data.fromBlock - blockCount < 0) {
        blockCount = data.fromBlock + 1;
      }

      async.times(blockCount, function(n, next) {
        web3.eth.getBlock(data.lastBlock - n, true, function(err, block) {
          next(err, block);
        });
      }, function(err, blocks) {
        if (err) {
          return next(err);
        }

        blocks.forEach(function(block) {
          block.transactions.forEach(function(e) {
            if (req.params.account == e.from || req.params.account == e.to) {
              traces.push(e);
            }
          });
        });
        callback(null, traces);
      });
    }
  ], function(err, traces) {
    if (err) {
      return next(err);
    }
    
    var tracesSent = [];
    var tracesReceived = [];

    data.address = req.params.account;

    traces.forEach(function(trace) {

      if (trace.from == data.address) {
        tracesSent.push(trace);
      } else {
        tracesReceived.push(trace);
      }
    });
    
    data.tracesSent = tracesSent;
    data.tracesReceived = tracesReceived;

    
    var blocks = {};
    data.tracesSent.forEach(function(trace) {
      if (!blocks[trace.blockNumber]) {
        blocks[trace.blockNumber] = [];
      }
      
      blocks[trace.blockNumber].push(trace);
    });
    data.tracesReceived.forEach(function(trace) {
      if (!blocks[trace.blockNumber]) {
        blocks[trace.blockNumber] = [];
      }
      
      blocks[trace.blockNumber].push(trace);
    });
    
    data.tracesSent = null;
    data.tracesReceived = null;
    data.blocks = [];
    var txCounter = 0;
    for (var block in blocks) {
      data.blocks.push(blocks[block]);
      txCounter++;
    }
    
    if (data.source) {
      data.name = data.source.name;
    } else if (config.names[data.address]) {
      data.name = config.names[data.address];
    }
    
    data.blocks = data.blocks.reverse().splice(0, 100);
    
    res.render('account', { account: data });
  });
  
});

module.exports = router;
