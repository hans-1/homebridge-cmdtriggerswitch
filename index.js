"use strict";

var Service, Characteristic, HomebridgeAPI;
var exec = require('child_process').exec;

module.exports = function(homebridge) {

  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  homebridge.registerAccessory("homebridge-cmdtriggerswitch", "CmdTriggerSwitch", CmdTriggerSwitch);
}

function CmdTriggerSwitch(log, config) {
  this.log = log;
  this.name = config.name;
  this.stateful = config.stateful;
  this.delay = config.delay ? config.delay : 1000;
  this.timeout = -1;		
  this.onCmd = config.onCmd;
  this.offCmd = config.offCmd;
  this._service = new Service.Switch(this.name);
  
  this.cacheDirectory = HomebridgeAPI.user.persistPath();
  this.storage = require('node-persist');
  this.storage.initSync({dir:this.cacheDirectory, forgiveParseErrors: true});
  
  this._service.getCharacteristic(Characteristic.On)
    .on('set', this._setOn.bind(this));

  if (this.stateful) {
    var cachedState = this.storage.getItemSync(this.name);
    if((cachedState === undefined) || (cachedState === false)) {
      this._service.setCharacteristic(Characteristic.On, false);
    } else {
      this._service.setCharacteristic(Characteristic.On, true);
    }
  }
}

CmdTriggerSwitch.prototype.getServices = function() {
  return [this._service];
}

CmdTriggerSwitch.prototype._setOn = function(on, callback) {

  this.log("Setting switch to " + on);

  if (this.stateful) {
	  this.storage.setItemSync(this.name, on);
  } else {
    if (on) {
      this.timeout = setTimeout(function() {
        this._service.setCharacteristic(Characteristic.On, false);
      }.bind(this), this.delay);
    } else {
      if (this.timeout !== -1) {
        clearTimeout(this.timeout);
      }
    }
  }

  if (on) {
    this.log("Executing ON command: '" + this.onCmd + "'");
    exec(this.onCmd);
  } else {
    this.log("Executing OFF command: '" + this.offCmd + "'");
    exec(this.offCmd);
  }

  callback();
}