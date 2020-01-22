"use strict";

var Service, Characteristic, HomebridgeAPI;
var exec = require('child_process').exec;
var inherits = require('util').inherits;


module.exports = function(homebridge) {

  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  homebridge.registerAccessory("homebridge-cmdtriggerswitch", "CmdTriggerSwitch", CmdTriggerSwitch);
}

function keepIntInRange(num, min, max){
  const parsed = parseInt(num);
  return Math.min(Math.max(parsed, min), max);
}

function CmdTriggerSwitch(log, config) {
  this.name = config.name;
  this.onCmd = config.onCmd;
  this.offCmd = config.offCmd;
  this.stateful = config.stateful ? config.stateful : false;
  this.delay = config.delay ? parseInt(config.delay) : 1000;
  this.delayUnit = config.delayUnit ? config.delayUnit : "ms";
  this.interactiveDelay = false;
  if (config.interactiveDelaySettings !== undefined) {
    this.interactiveDelay = config.interactiveDelaySettings.interactiveDelay ? config.interactiveDelaySettings.interactiveDelay : false;
    this.interactiveDelayLabel = config.interactiveDelaySettings.interactiveDelayLabel ? config.interactiveDelaySettings.interactiveDelayLabel : "Delay";
    this.delayMin = config.interactiveDelaySettings.delayMin ? parseInt(config.interactiveDelaySettings.delayMin) : 100;
    this.delayMax = config.interactiveDelaySettings.delayMax ? parseInt(config.interactiveDelaySettings.delayMax) : 1000;
    this.delayStep = config.interactiveDelaySettings.delayStep ? parseInt(config.interactiveDelaySettings.delayStep) : 100;
  }

  this.timeout = -1;		
  this.log = log;

  if (this.delayMax <= this.delayMin) {
    throw new Error('Invalid configuration: delayMin must be smaller than delayMax');
  }

  if (this.delayStep >= (this.delayMax - this.delayMin)) {
    throw new Error('Invalid configuration: delayStep must be smaller than (delayMax - delayMin)');
  }

  this.delayFactor = 1;
  switch(this.delayUnit) {
    case "ms":
      this.delayFactor = 1;
      break;
    case "s":
      this.delayFactor = 1000;
      break;
    case "min":
      this.delayFactor = 60*1000;
      break;
    default:
      throw new Error('Invalid configuration: Unknown delayUnit (must be "ms", "s" or "min")');
      break;
  }
  
  
  // Persistent Storage
  //

  this.cacheDirectory = HomebridgeAPI.user.persistPath();
  this.storage = require('node-persist');
  this.storage.initSync({dir:this.cacheDirectory, forgiveParseErrors: true});
  
  // Switch service
  //

  this.switchService = new Service.Switch(this.name);

  this.switchService.getCharacteristic(Characteristic.On)
    .on('set', this.switchSetOn.bind(this));

  if (this.interactiveDelay && !this.stateful) {
    const label = `${this.interactiveDelayLabel} (${this.delayUnit})`;
    const minVal = this.delayMin;
    const maxVal = this.delayMax;
    const step = this.delayStep;
    Characteristic.Delay = function() {
      const props = {
        format: Characteristic.Formats.UINT64,
        minValue: minVal,
        maxValue: maxVal,
        minStep: step,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
      };
      // var label = theLabel;
      Characteristic.call(this, label, '8728b5cc-5c49-4b44-bb25-a4c4d4715779', props);
      this.value = this.getDefaultValue();
    };
    inherits(Characteristic.Delay, Characteristic);
    Characteristic.Delay.UUID = '8728b5cc-5c49-4b44-bb25-a4c4d4715779';
    this.switchService.addCharacteristic(Characteristic.Delay);

    this.switchService.getCharacteristic(Characteristic.Delay)
      .on('set', this.switchSetDelay.bind(this));

    const cachedInteractiveDelay = this.storage.getItemSync(`${this.name} - interactiveDelay`);
    if(cachedInteractiveDelay === undefined) {
      const cid = keepIntInRange(this.delay, this.delayMin, this.delayMax);
      this.switchService.setCharacteristic(Characteristic.Delay, cid);
    } else {
      const cid = keepIntInRange(cachedInteractiveDelay, this.delayMin, this.delayMax);
      this.switchService.setCharacteristic(Characteristic.Delay, cid);
      this.delay = cid;
    }
  }

  if (this.stateful) {
    const cachedState = this.storage.getItemSync(this.name);
    if((cachedState === undefined) || (cachedState === false)) {
      this.switchService.setCharacteristic(Characteristic.On, false);
    } else {
      this.switchService.setCharacteristic(Characteristic.On, true);
    }
  }

  // Accessory Information Service
  //

  this.accessoryInformationService =  new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Name, this.name)
    .setCharacteristic(Characteristic.Manufacturer, 'hans-1')
    .setCharacteristic(Characteristic.Model, 'Command Trigger Switch');

}

CmdTriggerSwitch.prototype.getServices = function() {
  return [this.accessoryInformationService,  this.switchService];
}

CmdTriggerSwitch.prototype.switchSetOn = function(on, callback) {

  this.log("Setting switch to " + on);

  if (this.stateful) {
	  this.storage.setItemSync(this.name, on);
  } else {
    if (on) {
      // this.log("Delay in ms: " + this.delay*this.delayFactor);
      this.timeout = setTimeout(function() {
        this.switchService.setCharacteristic(Characteristic.On, false);
      }.bind(this), this.delay*this.delayFactor);
    } else {
      if (this.timeout !== -1) {
        clearTimeout(this.timeout);
      }
    }
  }

  if (on) {
    if (this.onCmd !== undefined) {
      this.log("Executing ON command: '" + this.onCmd + "'");
      exec(this.onCmd);
    }
  } else {
    if (this.offCmd !== undefined) {
      this.log("Executing OFF command: '" + this.offCmd + "'");
      exec(this.offCmd);
    }
  }

  callback();
}

CmdTriggerSwitch.prototype.switchSetDelay = function(delay, callback) {
  // this.log(`${this.interactiveDelayLabel}: ${delay}${this.delayUnit}`);
  this.delay = delay;
  this.storage.setItemSync(`${this.name} - interactiveDelay`, delay);
  callback();
}
