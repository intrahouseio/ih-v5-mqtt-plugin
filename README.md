# ih-systems: Plugin mqttclient V5 

It's mqtt client without build-in broker.

You can use Mosquitto or other brokers, supported MQTT 3.1.1


Install mosquitto on Raspberry Pi (jessie or stretch):

sudo apt-get update

sudo apt-get upgrade

sudo wget http://repo.mosquitto.org/debian/mosquitto-repo.gpg.key

sudo apt-key add mosquitto-repo.gpg.key

sudo rm mosquitto-repo.gpg.key

cd /etc/apt/sources.list.d/

For jessie:
sudo wget http://repo.mosquitto.org/debian/mosquitto-jessie.list

For stretch:
sudo wget http://repo.mosquitto.org/debian/mosquitto-stretch.list

sudo apt-get update

sudo apt-get install mosquitto mosquitto-clients

Check:
sudo service mosquitto status


You can stop service and run CLI for debug:

sudo service mosquitto stop

mosquitto -v

