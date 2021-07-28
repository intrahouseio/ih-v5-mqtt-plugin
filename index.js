/*
 * Mqtt client V5
 */

const util = require('util');

const plugin = require('ih-plugin-api')();
const app = require('./app');

(async () => {
  plugin.log('Mqtt client has started.', 0);

  try {
    // Получить каналы для подписки
    plugin.channels = await plugin.channels.get();
    plugin.log('Received channels...');

    // Получить каналы для публикации
    plugin.extra = await plugin.extra.get();
    plugin.log('Received extra channels...');

    // Получить параметры и соединиться с брокером
    plugin.params = await plugin.params.get();
    plugin.log('Received params...');
    app(plugin);
  } catch (err) {
    plugin.exit(8, `Error: ${util.inspect(err)}`);
  }
})();
