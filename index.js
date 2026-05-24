"use strict";

var Service, Characteristic, HomebridgeAPI;
var exec = require('child_process').exec;
var inherits = require('util').inherits;
var storage = require('node-persist');


module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  homebridge.registerAccessory("homebridge-cmdtriggerswitch", "CmdTriggerSwitch", CmdTriggerSwitch);
}

function keepIntInRange(num, min, max){
  const parsed = parseInt(num);
  if (isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function CmdTriggerSwitch(log, config) {
  this.log = log;
  this.timeout = -1;
  this.storageAvailable = false;

  // Setup Configuration
  //
  this.setupConfig(config);

  // Persistent Storage
  //
  this.cacheDirectory = HomebridgeAPI.user.persistPath();
  this.storageReady = storage.init({dir: this.cacheDirectory, forgiveParseErrors: true})
    .then(() => this._restoreState())
    .then(() => { this.storageAvailable = true; })
    .catch(err => this.log.error('Storage init error: ' + err));

  // Setup Services
  //
  this.createSwitchService();
  this.createAccessoryInformationService();
}

CmdTriggerSwitch.prototype.setupConfig = function(config) {
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
}

CmdTriggerSwitch.prototype.createSwitchService = function() {
  this.switchService = new Service.Switch(this.name);

  this.switchService.getCharacteristic(Characteristic.On)
    .onGet(() => {
      return this.switchService.getCharacteristic(Characteristic.On).value;
    })
    .onSet(this.switchSetOn.bind(this));

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
      Characteristic.call(this, label, '8728b5cc-5c49-4b44-bb25-a4c4d4715779', props);
      this.value = this.getDefaultValue();
    };
    inherits(Characteristic.Delay, Characteristic);
    Characteristic.Delay.UUID = '8728b5cc-5c49-4b44-bb25-a4c4d4715779';
    this.switchService.addCharacteristic(Characteristic.Delay);

    this.switchService.getCharacteristic(Characteristic.Delay)
      .onGet(() => {
        return this.switchService.getCharacteristic(Characteristic.Delay).value;
      })
      .onSet(this.switchSetDelay.bind(this));
  }
}

CmdTriggerSwitch.prototype._scheduleAutoOff = function(delayMs) {
  clearTimeout(this.timeout);
  this.timeout = setTimeout(() => {
    this.switchService.setCharacteristic(Characteristic.On, false);
  }, delayMs);
}

CmdTriggerSwitch.prototype._cancelAutoOff = function() {
  clearTimeout(this.timeout);
  this.timeout = -1;
}

CmdTriggerSwitch.prototype._restoreState = async function() {
  if (this.interactiveDelay && !this.stateful) {
    const cachedInteractiveDelay = await storage.getItem(`${this.name} - interactiveDelay`);
    if (cachedInteractiveDelay === undefined) {
      const cid = keepIntInRange(this.delay, this.delayMin, this.delayMax);
      this.switchService.updateCharacteristic(Characteristic.Delay, cid);
    } else {
      const cid = keepIntInRange(cachedInteractiveDelay, this.delayMin, this.delayMax);
      this.switchService.updateCharacteristic(Characteristic.Delay, cid);
      this.delay = cid;
    }
  }

  if (this.stateful) {
    const cachedState = await storage.getItem(this.name);
    this.switchService.updateCharacteristic(Characteristic.On, cachedState === true);
  } else {
    const cachedStartTime = await storage.getItem(`${this.name} - startTime`);
    if (cachedStartTime !== undefined) {
      const diffTime = Date.now() - cachedStartTime;
      this.log('diffTime: ' + diffTime/1000 + 's');
      if (diffTime > 0 && diffTime < this.delay*this.delayFactor) {
        const remaining = this.delay*this.delayFactor - diffTime;
        this.switchService.updateCharacteristic(Characteristic.On, true);
        this.log(`Restored switch state to ON after restart, remaining delay ${remaining}ms`);
        this._scheduleAutoOff(remaining);
      }
    }
  }
}

CmdTriggerSwitch.prototype.createAccessoryInformationService = function() {
  this.accessoryInformationService =  new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Name, this.name)
    .setCharacteristic(Characteristic.Manufacturer, 'hans-1')
    .setCharacteristic(Characteristic.Model, 'Command Trigger Switch');
}

CmdTriggerSwitch.prototype.getServices = function() {
  return [this.accessoryInformationService,  this.switchService];
}

CmdTriggerSwitch.prototype.switchSetOn = async function(on) {

  this.log("Setting switch to " + on);

  await this.storageReady;
  if (!this.storageAvailable) {
    this.log.error("Cannot set state: storage unavailable");
    return;
  }

  if (this.stateful) {
    await storage.setItem(this.name, on);
  } else {
    if (on) {
      const delayMs = this.delay*this.delayFactor;
      await storage.setItem(`${this.name} - startTime`, Date.now());
      this.log("Delay in ms: " + delayMs);
      this._scheduleAutoOff(delayMs);
    } else {
      this._cancelAutoOff();
      await storage.removeItem(`${this.name} - startTime`);
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
}

CmdTriggerSwitch.prototype.switchSetDelay = async function(delay) {
  this.delay = delay;
  await this.storageReady;
  if (!this.storageAvailable) {
    this.log.error("Cannot save delay: storage unavailable");
    return;
  }
  await storage.setItem(`${this.name} - interactiveDelay`, delay);
}
