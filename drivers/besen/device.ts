import Homey from 'homey';
import BESENDriver = require('./driver');

type EmEvseMetaStates = any;

class BESENDevice extends Homey.Device {

  private ip:string = "";
  private password:string = "";
  private userid:string="";
  private evseDevice:any = null

  private charger_plugged_in:any = null;
  private charger_plugged_out:any = null;
  
  private charger_plugged_in_state:boolean = false; 

  private get d(): BESENDriver {
    return this.driver as BESENDriver;
  }

  private get Communicator() {
    return this.d.communicator;
  }

  private get Evse():any {
    try
    {
      if(this.evseDevice == null)
      {
        this.log(`Get EVSE at ip ${this.ip}`);
        this.evseDevice = this.Communicator.getEvseByIp(this.ip);
      }
    }
    catch{}
    
    return this.evseDevice;
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('BESEN device has been initialized');

    this.ip = this.getStoreValue('ip');
    this.password = this.getStoreValue('password');
    this.userid = this.getStoreValue('userid');

    if(!this.hasCapability("override_reset"))
    {
      this.addCapability("override_reset");
    }

    if(!this.hasCapability("power_level"))
    {
      this.addCapability("power_level");
    }

    if(this.hasCapability("override_current_a"))
    {
      this.removeCapability("override_current_a");
    }

    this.registerCapabilityListener('evcharger_charging', this.StartStopCharging.bind(this));

    this.registerCapabilityListener('power_level', async (value) => {
      await this.apiSetOverrideCurrent(Number(value));
    });

    this.registerCapabilityListener('override_reset', async (value) => {
      await this.apiResetOverrideCurrent(Boolean(value));
    });
  }

  async pollOnceSafe(){}

  async apiResetOverrideCurrent(reset:boolean){
    this.log(`Reset limited charge - ${reset}`);

    if(reset) {
      var info = this.Evse.getInfo();
      await this.setCapabilityValue('power_level', 1);
    }
  }

  async apiSetOverrideCurrent(power_level:number)
  {
    power_level = Math.min(1,power_level);
    
    var info = this.Evse.getInfo();
    this.log(`Max limited charge charger ${info?.maxElectricity}`);
    this.log(`Power level limited charge ${power_level * 100}%`);

    let charger_limit_amp = info?.maxElectricity * power_level;
    charger_limit_amp = Math.round(charger_limit_amp);

    if(charger_limit_amp < 6)
    {
      this.log(`Charger too low, minimum of 6 amp. Reset power level`);
      charger_limit_amp = 6;
    }

    //Recalc the powerlevel due to rounding amps
    power_level = (1 / info?.maxElectricity) * charger_limit_amp;
    this.log(`New Power level ${power_level * 100}%`);
    await this.setCapabilityValue('power_level', power_level);

    //Set new limit charger
    this.log(`Set limited charge ${charger_limit_amp}`);
    this.Evse.setMaxElectricity(charger_limit_amp);
  }

  async ChargingState(metaState:string, opts:any = null) {
    this.log(`Charge state changed - ${metaState} - ${this.charger_plugged_in_state}`);

    if(this.charger_plugged_in_state == false && (metaState == "plugged_in" || metaState == "plugged_in_charging"))
    {
      this.charger_plugged_in = this.homey.flow.getDeviceTriggerCard("charger_plugged_in");

      await this.charger_plugged_in.trigger(this);
      //await this.setAvailable();

      this.charger_plugged_in_state = true;
      return;
    }

    if(this.charger_plugged_in_state == true && (metaState == "plugged_out"))
    {
      this.charger_plugged_out = this.homey.flow.getDeviceTriggerCard("charger_plugged_out");

      await this.charger_plugged_out.trigger(this);
      //await this.setUnavailable('Please connect and plug in!');
      this.charger_plugged_in_state = false;
      return;
    }
  }

  async StartStopCharging(value:boolean, opts:any) {
    var metaState = this.Evse.getMetaState();

    if(metaState != "PLUGGED_IN" && metaState != "CHARGING") {
      //await this.setUnavailable('Please connect and plug in!');
      return;
    }

    if(value)
    {
      /*
      var info = this.Evse.getInfo();
      let power_level = await this.getCapabilityValue('power_level');
      let maxCurrentA = info?.maxElectricity * (power_level/100);
      
      this.Evse.chargeStart({"userId":"homey", "maxAmps":maxCurrentA});
      */
      this.Evse.chargeStart();
    }
    else
      this.Evse.chargeStop({"userId":"homey"});
  }

  /*
   * Update is triggered from the driver / communicator
   */
  async Update() {
    this.log(`Update device`);

    if(this.Evse == null)
      return;

    var metaState = this.Evse.getMetaState();
    var charge = this.Evse.getCurrentCharge();
    var state = this.Evse.getState();
    var info = this.Evse.getInfo();

    /*
    if(info?.maxElectricity !== undefined)
    {
      var info = this.Evse.getInfo();
      let power_level = await this.getCapabilityValue('power_level');
      let maxCurrentA = info?.maxElectricity * (power_level/100);

      if(maxCurrentA == null || maxCurrentA == undefined)
      {
        await this.setCapabilityValue('override_current_a', info?.maxElectricity);
      }
    }
    */

    if(state?.innerTemp !== undefined)
      await this.setCapabilityValue('measure_temperature', state?.innerTemp);

    this.log(`${metaState}`);

    if(charge?.currentKWhCounter !== undefined && charge?.currentKWhCounter !== 0)
    {
      await this.setStoreValue("currentKWhCounter", charge?.currentKWhCounter);
    }

    let currentKWhCounter = await this.getStoreValue("currentKWhCounter");
    await this.setCapabilityValue('meter_power', currentKWhCounter);

    if(metaState == "OFFLINE"){
      await this.setUnavailable('Charger is offline');
      return;
    }

    if(metaState == "NOT_LOGGED_IN"){
      if(this.password == "" ||this.password == undefined)
      {
        await this.setUnavailable('Please provide password within the device settings');
      }
      else
      {
        this.Evse.login(this.password);
      }
      return;
    }

    await this.setAvailable();

    if(metaState == "CHARGING")
    {
      await this.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
      await this.setCapabilityValue('evcharger_charging', true);

      if(state?.currentPower !== undefined)
        await this.setCapabilityValue('measure_power', state?.currentPower);
    }
    else
    {
      await this.setCapabilityValue('evcharger_charging', false);
      await this.setCapabilityValue('measure_power', 0);

      if(metaState == "PLUGGED_IN")
        await this.setCapabilityValue('evcharger_charging_state', 'plugged_in');
      else
        await this.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    }

    await this.ChargingState(this.getCapabilityValue('evcharger_charging_state')); 
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('BESEN device has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log("MyDevice settings where changed");

    if (changedKeys.includes('userid')) {
      await this.setStoreValue("userid", newSettings.userid);
      this.userid = newSettings.userid as string;
    }

    if (changedKeys.includes('password')) {
      await this.setStoreValue("password", newSettings.password);
      this.password = newSettings.password as string;
    }

    await this.setAvailable();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('BESEN device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('BESEN device has been deleted');
  }

};

export = BESENDevice