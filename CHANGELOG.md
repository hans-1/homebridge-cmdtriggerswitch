# Change Log

All notable changes to this project are documented in this file. This project uses [Semantic Versioning](https://semver.org/).

## 1.2.0 (2020-01-31)

### Notable Changes

* New feature ([#2](https://github.com/hans-1/homebridge-cmdtriggerswitch/issues/2)):  After a reboot of Homebridge, a stateless switch checks if there is a remaining delay-time and stays on for this timespan. This is specifically useful for stateless switches with high delay values.

* Bug fix: After a reboot of Homebrdige the CLI commands specified at 'onCmd' or 'offCmd' have been erroneously executed. This is now fixed. 

## 1.1.0 (2020-01-23)

### Notable Changes

* New feature ([#1](https://github.com/hans-1/homebridge-cmdtriggerswitch/issues/1)): Directly change the timeout value (delay) for a stateless switch in a supported HomeKit app like 'Eve for HomeKit'.
* New feature: Specify the unit of delay values (milliseconds, seconds or minutes).


## 1.0.0 (2020-01-17)

Initial release.
