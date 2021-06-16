/*
 * Mqtt client V5
 */

const util = require('util');

const plugin = require('ih-plugin-api')();
const Agent = require('./agent');

const agent = new Agent();
init();

async function init() {
  plugin.log('Mqtt client has started.', 0);

  try {
    // Получить каналы для подписки
    agent.channels = await plugin.channels.get();
    plugin.log('Received channels...');

    // Получить каналы для публикации
    agent.extra = await plugin.extra.get();
    plugin.log('Received extra channels...');

    // Получить параметры и соединиться с брокером
    const params = await plugin.params.get();
    Object.assign(agent.params, params);
    plugin.log('Received params...');

    agent.connect();
  } catch (err) {
    plugin.exit(8, `Error! Message: ${util.inspect(err)}`);
  }
};

// --- События плагина ---

/**  act
 * Получил от сервера команду(ы) для устройства - отправить брокеру
 * @param {Array of Objects} - data - массив команд
 *                            В команде  должен быть topic и message
 */
plugin.on('act', data => {
  if (!data) return;
  data.forEach(item => {
    try {
      const pubStr = agent.publishAct(item);
      plugin.log('PUBLISH: ' + pubStr, 1);
    } catch (e) {
      logError(e, `Publish topic ${item.topic} message ${item.message}`);
    }
  });
});

/**  sub
 * Получил данные от сервера по подписке (публикация данных) - отправить брокеру
 * @param {Array of Objects} - data - массив данных
 *                             Элемент должен содержать dn, val
 */
plugin.on('sub', data => {
  if (!data) return;
  data.forEach(item => {
    try {
      const pubStr = agent.publishData(item);
      plugin.log('PUBLISH: ' + pubStr, 2);
    } catch (e) {
      logError(e, `Publish dn=${item.dn} value=${item.val}`);
    }
  });
});


/**  command:  {type:'command', command:'publish', data:{topic, message, options}}
 * 
 * Получил от сервера команду  - отправить брокеру или можно выполнить на уровне плагина
 * 
 * @param {Array of Objects || Object} - data - массив объектов или объект
 *                             Элемент должен содержать dn, val
 */
plugin.on('command', message => {
  if (!message) return;
  let data;
  switch (message.command) {
    case 'publish': // Команда на прямую публикацию
      if (!message.data) return plugin.log('Not found data: ' + util.inspect(message));
      if (typeof message.data != 'object') return plugin.log('Invalid data: ' + util.inspect(message));

      data = !Array.isArray(message.data) ? [message.data] : message.data;
      data.forEach(item => {
        try {
          if (item.topic) agent.publish(item.topic, item.message || '', item.options || {});
        } catch (e) {
          logError(e, `Publish topic ${item.topic} message ${item.message}`);
        }
      });
      break;
    default:
      plugin.log('Missing or invalid command! Expected command:publish!');
  }
});

// События при изменении каналов
/**
 * Добавлены каналы
 * @param {Array of Objects} recs
 */
plugin.onAdd('channels', recs => {
  // console.log('PLUGIN MQTT onAdd docs=' + util.inspect(recs));
  recs.forEach(rec => {
    agent.addChannel(rec);
  });
});

/**
 * Изменены каналы
 * @param {Array of Objects} recs
 */
plugin.onUpdate('channels', recs => {
  // console.log('PLUGIN MQTT onUpdate docs=' + util.inspect(recs));
  recs.forEach(rec => {
    agent.updateChannel(rec);
  });
});

/**
 * Удалены каналы
 * @param {Array of Objects} recs
 */
plugin.onDelete('channels', recs => {
  // console.log('PLUGIN MQTT onDelete docs=' + util.inspect(recs));
  recs.forEach(rec => {
    agent.deleteChannel(rec);
  });
});


plugin.on('exit', () => {
  processExit(0);
});

/* События агента */
// Отправка данных каналов 
agent.on('senddata', data => {
  plugin.sendData(data);
});

// Отправка других сообщений 
agent.on('send', (type, data) => {
  plugin.send(type, data);
});

// Логирование
agent.on('log', (text, level) => {
  plugin.log(text, level);
});

// Фатальная ошибка агента -> выход плагина
agent.on('error', txt => {
  processExit(1, 'ERROR: '+txt);
});

/* Private functions */
function logError(err, txt = '') {
  plugin.log(txt + ' ERROR! ' + JSON.stringify(err));
}

function processExit(errcode = 0, txt = '') {
  // Здесь закрыть/ сохранить все что нужно при выходе
  agent.end();

  if (txt) plugin.log(txt);
  setTimeout(() => {
    process.exit(errcode);
  }, 300);
}
