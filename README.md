# homebridge-cmdtriggerswitch

Example config.json with a stateful switch:
```
    "accessories": [
        {
            "accessory": "CmdTriggerSwitch",
            "name": "Heating,
            "stateful": true,
            "onCmd": "echo Heating ON",
            "offCmd": "echo Heating OFF"
        }
    ]
```

Example config.json with a (simulated) stateless switch:
```
    "accessories": [
        {
            "accessory": "CmdTriggerSwitch",
            "name": "Switch-01,
            "stateful": false,
            "onCmd": "Switch-01 is now OM",
            "offCmd": "Switch-01 is now OFF",
            "delay": 1000
        }
    ]
```

With this plugin, you can create any number of fake switches that will execute a CLI command when turned off or on. This is usefull to trigger commands that are executed on the server running homebridge. This can be very useful for advanced automation with HomeKit scenes like sending an email when a scene becomes active. Or you could tell Siri to start a backup.

## Stateful Switches

The default behavior of a statefull CmdTriggerSwitch is that it remains on and must be manually turned off. You can do this by passing the 'stateful' argument with the value true in your config.json:

```
    "accessories": [
        {
            "accessory": "CmdTriggerSwitch",
            "name": "Heating,
            "stateful": true,
            "onCmd": "echo Heating ON",
            "offCmd": "echo Heating OFF"
        }
    ]
```
The argument 'onCmd' is used to specifiy the CLI command that is executed when the switch is turned on and the argument 'offCmd' is used to spedify the CLI command that is executed when the switch is turned off.


## Stateless Switches

You may also want to create a stateless CmdTriggerSwitch that turns itself off after being on for a given time (for example, five seconds). This can be done by passing the 'stateful' argument with the value false and the 'delay' argument with the timeout value (in milliseconds) in your config.json:

```
    "accessories": [
        {
            "accessory": "CmdTriggerSwitch",
            "name": "Switch-01,
            "stateful": false,
            "onCmd": "Switch-01 is now OM",
            "offCmd": "Switch-01 is now OFF",
            "delay": 5000
        }
    ]
```
The argument 'onCmd' is used to specifiy the CLI command that is executed when the switch is turned on and the argument 'offCmd' is used to spedify the CLI command that is executed when the switch is turned off.

## Arguments

| Argument  | Description                                                                | Required |
|-----------|----------------------------------------------------------------------------|----------|
| accessory | Must always be `CmdTriggerSwitch`.                                         | Yes      |
| name      | Name of the switch. Must be unique.                                        | Yes      |
| stateful  | Flag to indicate if the switch is stateful (true) or stateless (false).    | Yes      |
| onCmd     | CLI command that is executed when the switch is turned on.                 | No       |
| offCmd    | CLI command that is executed when the switch is turned off.                | No       |
| delay     | Timeout value in milliseconds after that the switch turns itself off. If not specified, defaults to 1000ms. Only evaluated for stateless switches.                                                                                                   | No       |
