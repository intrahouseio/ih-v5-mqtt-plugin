/*
 * Mqtt client V5
 */

const util = require('util');

const app = require('./app');

(async () => {

  let plugin;
  try {
    const opt = getOptFromArgs();
    const pluginapi = opt && opt.pluginapi ? opt.pluginapi : 'ih-plugin-api';
    plugin = require(pluginapi+'/index.js')();
    plugin.log('Mqtt client has started.', 0);

    // Получить каналы для подписки
    plugin.channels = await plugin.channels.get();
    plugin.log('Received channels...', 1);

    // Получить каналы для публикации
    plugin.extraChannels = await plugin.extra.get();
    plugin.log('Received extra channels...', 1);

    // Получить параметры и соединиться с брокером
    plugin.params = await plugin.params.get();
    plugin.log('Received params...');
    app(plugin);
  } catch (err) {
    plugin.exit(8, `Error: ${util.inspect(err)}`);
  }
})();


function getOptFromArgs() {
  let opt;
  try {
    opt = JSON.parse(process.argv[2]); 
  } catch (e) {
    opt = {};
  }
  return opt;
}
