import Homey from 'homey';
import MyDevice = require('./device');

type EmEvse = /*unresolved*/ any;
type EmCommunicator = any;

class BESENDriver extends Homey.Driver {

  public evses:EmEvse[] = [];
  private evsesFile = 'evses.json';
  public communicator:EmCommunicator = null;
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
 
    const { createCommunicator } = await import('emproto');

    this.log('MyDriver has been initialized');

    this.communicator = createCommunicator();
    await this.communicator.start();

    this.communicator.addEventListener(["CHANGED"], (evse:EmEvse,event:string) => {
      this.event(evse, event, this)
  });
  }

  async event(evse:EmEvse,event:string,homey:BESENDriver){
    homey.log(`EVSE update- ${event}`);
    var info = evse.getInfo();

    try{
      let device = homey.getDevice({ id: info.serial, ip: info.ip });

      (device as MyDevice).Update();
    } catch{}
  }

  async onUninit(): Promise<void> {
    this.communicator.stop();
  }

  /**
   * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    this.log('List devices');
    this.evses = this.communicator.getEvses();

    this.log(`EVSEs found ${this.evses.length}`);

    let devices = [];

    for(var d of this.evses.values()) {
      var info = d.getInfo();
      var label = d.getLabel();
      var config = d.getConfig();

      this.log(label);

      devices.push({
          name: config.name,
          data: { id: info.serial, ip: info.ip },
          store: { id: info.serial, ip: info.ip },
      });
    }
        
    return devices;
  }

};

export = BESENDriver