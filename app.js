/**
 * app.js
 * Wraps a client connection to an MQTT broker
 */

const util = require('util');
const mqtt = require('mqtt');

const converter = require('./lib/converter');
const Scanner = require('./lib/scanner');


module.exports = async function(plugin) {
  const scanner = new Scanner(plugin);

  // Подготовить каналы для подписки на брокере
  converter.createSubMap(plugin.channels);

  // Подготовить каналы для публикации - нужно подписаться на сервере IH на эти устройства
  const filter = converter.saveExtraGetFilter(plugin.extra);
  if (filter) {
    plugin.send({ type: 'sub', id: 'main', event: 'devices', filter });
    plugin.log('SEND: '+util.inspect({ type: 'sub', id: 'main', event: 'devices', filter }));
  }

  let client = '';
  connect();


  function connect() {
    const { host, port, use_password, username, password } = plugin.params;
    const options = { host, port };
    let authStr = '';
    if (use_password) {
      Object.assign(options, { username, password });
      authStr = 'username = ' + username;
    }

    plugin.log(`Start connecting ${host}:${port} ${authStr}`, 1);
    client = mqtt.connect(options);

    // Подключение успешно
    client.on('connect', () => {
      plugin.log('Connected', 1);
      subscribe(converter.getSubMapTopics());
    });

    // Получены данные
    client.on('message', (topic, message) => {
      message = message.toString();
      plugin.log('GET: ' + topic + ' ' + message, 2);
      if (scanner.status > 0) {
        scanner.process(topic, message);
      }
      processMessage(topic, message);
    });

    // Ошибка
    client.on('error', err => {
      plugin.exit(1, 'Connection error:  ' + JSON.stringify(err));
    });

    client.on('offline', () => {
      plugin.exit(1, 'Connection error: Host is offline');
      // plugin.log('Host is offline');
    });

    // Сообщения от библиотеки для отладки
    client.on('packetsend', packet => {
      plugin.log('Packet send. cmd:' + packet.cmd, 2);
    });

    client.on('packetreceive', packet => {
      plugin.log('Packet receive. cmd: ' + packet.cmd, 2);
    });
  }

  function processMessage(topic, message) {
    if (converter.startsceneMap.has(topic)) {
      converter.startsceneMap.get(topic).forEach(item => {
        plugin.send({ type: 'startscene', id: item, arg: { topic, message } });
      });
    }

    const data = converter.convertIncoming(topic, message);
    if (data) {
      // Если value - это объект и нужно извлекать время - в каждом элементе извлечь время
      try {
        if (plugin.params.extract_ts && plugin.params.ts_field) processTimestamp(data);
        plugin.sendData(data);
      } catch (e) {
        plugin.log('Time process error, expected JSON with "' + plugin.params.ts_field + '" property');
      }
    }
  }

  function subscribe(topics) {
    if (!topics) return;
    plugin.log('SUBSCRIBE: ' + topics.join(', '), 2);
    client.subscribe(topics, err => {
      if (err) {
        plugin.log('ERROR subscribing: ' + util.inspect(err));
      }
    });
  }

  function publishAct(item) {
    // if (!item.topic) return;
    let topic = item.pubtopic;
    let mes = item.pubmessage;
    // if (item.act == 'set' && (!item.message || item.message == 'value')) item.message = String(item.value);
    if (!mes || mes == 'value') mes = String(item.value);

    const func = new Function('value', 'return ' + mes + ';');
    // plugin.log('FUNC='+func.toString())
    const message = func(item.value) || '';
    publish(topic, message);
    return item.topic + ' ' + message;
  }

  function publishData(item) {
    let pobj = converter.convertOutgoing(item.dn, item.val);
    if (pobj) publish(pobj.topic, pobj.message, pobj.options);
    return pobj.topic + ' ' + pobj.message;
  }

  function publish(topic, message, options) {
    if (!topic || !message) return;
    plugin.log('PUBLISH: ' + topic + ' ' + message, 2);
    client.publish(topic, message, options, err => {
      if (err) {
        plugin.log('ERROR publishing topic=' + topic + ': ' + util.inspect(err));
      }
    });
  }

  function addChannel({ id, topic }) {
    if (!topic || !id) return;
    // Добавить топик в subMap; подписаться на него, если пока нет подписки
    const newtopic = converter.addSubMapItem(topic, id);
    if (newtopic) subscribe(newtopic);
  }

  function updateChannel({ oldid, id, topic }) {
    if (!oldid || !id) return;
    const oldtopic = converter.findTopicById(oldid);
    if (oldtopic == topic) {
      // Изменилось только id - топик не дергать (subscribe/unsubscribe)
      if (oldid != id) {
        converter.deleteSubMapItem(topic, oldid);
        addChannel({ id, topic });
      }
      return;
    }
    // Топик изменился
    deleteChannel({ oldid });
    addChannel({ id, topic });
  }

  function deleteChannel({ oldid }) {
    if (!oldid) return;
    const topic = converter.findTopicById(oldid);
    const restopic = converter.deleteSubMapItem(topic, oldid);
    if (restopic) client.unsubscribe(restopic);
  }

  /**
   * Добавляет к элементам массива data поле ts, содержащее timestamp
   *
   * @param {Array of Objects} data - массив входящих данных: {id, topic, value}
   *        value может быть объектом, тогда из него извлечь
   * @param {String} ts_field - имя свойства, содержащего время в каком-то формате??
   *
   * @throw при JSON.parse
   */
  function processTimestamp(data, ts_field) {
    data.forEach(item => {
      if (item.value) {
        let vobj = JSON.parse(item.value);
        if (vobj[ts_field]) {
          item.ts = new Date(vobj.ts).getTime();
        }
      }
    });
  }

  // --- События плагина ---
  // Сканирование
  plugin.onScan(scanObj => {
    if (!scanObj) return;
    if (scanObj.stop) {
      scanStop();
    } else if (scanObj.uuid) {
      scanRequest(scanObj);
    }
  });

  function scanRequest(scanObj) {
    const scanTopic = scanner.request(scanObj);
    if (scanTopic) {
      client.subscribe(scanTopic, err => {
        if (err) {
          plugin.log('ERROR subscribe on ' + scanTopic + ': ' + util.inspect(err));
          scanner.stop();
        }
      });
    }
  }

  function scanStop() {
    const scanTopic = scanner.stop();
    // Отписаться и подписаться заново!!
    if (scanTopic) {
      client.unsubscribe(scanTopic, err => {
        if (!err) {
          // Заново подписаться на топики из каналов
          subscribe(converter.getSubMapTopics());
        } else {
          // plugin.log('ERROR unsubscribe on '+scanTopic +': '+ util.inspect(err));
          plugin.exit(1, 'ERROR unsubscribe on ' + scanTopic + ': ' + util.inspect(err));
        }
      });
    }
  }

  /**  act
   * Получил от сервера команду(ы) для устройства - отправить брокеру
   * @param {Array of Objects} - data - массив команд
   *                            В команде  должен быть topic и message
   */
  plugin.onAct(message => {
    plugin.log('ACT data=' + util.inspect(message));
    if (!message.data) return;
    message.data.forEach(item => {
      try {
        const pubStr = publishAct(item);
        plugin.log('PUBLISH ' + pubStr, 1);
      } catch (e) {
        const errStr = 'PUBLISH for ' + util.inspect(item) + ' ERROR: ' + util.inspect(e);
        plugin.log(errStr);
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
        const pubStr = publishData(item);
        plugin.log('PUBLISH: ' + pubStr, 2);
      } catch (e) {
        const errStr = 'PUBLISH for ' + util.inspect(item) + ' ERROR: ' + util.inspect(e);
        plugin.log(errStr);
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
            if (item.topic) publish(item.topic, item.message || '', item.options || {});
          } catch (e) {
            const errStr = 'PUBLISH for ' + util.inspect(item) + ' ERROR: ' + util.inspect(e);
            plugin.log(errStr);
          }
        });
        break;
      default:
        plugin.log('Missing or invalid command! Expected command:publish!');
    }
  });

  // События при изменении каналов, recs = {Array of Objects}
  plugin.onAdd('channels', recs => {
    recs.forEach(rec => addChannel(rec));
  });

  plugin.onUpdate('channels', recs => {
    recs.forEach(rec => updateChannel(rec));
  });

  plugin.onDelete('channels', recs => {
    recs.forEach(rec => deleteChannel(rec));
  });

  plugin.on('exit', () => {
    if (client) client.end();
  });
};
