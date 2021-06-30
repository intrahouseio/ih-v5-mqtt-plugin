/**
 * app.js
 * Wraps a client connection to an MQTT broker
 */

const util = require('util');
const mqtt = require('mqtt');

const converter = require('./lib/converter');
const Tree = require('./lib/topicstree');

module.exports = async function(plugin) {
  // Подготовить каналы для подписки на брокере
  converter.createSubMap(plugin.channels);

  // Подготовить каналы для публикации - нужно подписаться на сервере IH на эти устройства
  const filter = converter.saveExtraGetFilter(plugin.extra);
  if (filter) plugin.send({ type: 'sub', id: 'main', event: 'devices', filter });

  let client = '';

  const scanTopic = '#';
  let scanTree = '';
  let scanStatus = 0;
  const scanClients = new Set(); // Список uuid на время сканирования

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
      if (scanStatus > 0) {
        processScan(topic, message);
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

  function processScan(topic, message) {
    const result = scanTree.add(topic, message);
    if (scanStatus == 2) {
      // Дослать изменения
      const resObj = {};
      if (result.added) {
        resObj.op = 'add';
        resObj.data = result.added.data;
        resObj.parentid = result.added.parentid;
      } else if (result.updated) {
        resObj.op = 'update';
        resObj.data = result.updated;
      }
      if (resObj.op) {
        plugin.send({ type: 'scan', ...resObj, scanid: 'root' });
      } // Отправить на сервер, pluginengine сам определяет uuid для досылки
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
    if (!item.topic) return;
    // if (item.act == 'set' && (!item.message || item.message == 'value')) item.message = String(item.value);
    if (!item.message || item.message == 'value') item.message = String(item.value);

    const func = new Function('value', 'return `' + item.message + '`;');
    const message = func(item.value) || '';
    publish(item.topic, message);
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
    // Отписка
    if (scanObj.stop) return scanStop();

    plugin.log('SUBSCRIBE FOR SCAN: ' + util.inspect(scanObj));
    // 3 варианта scanStatus:
    // 0. Первый клиент на сканирование - все с начала - отправка будет через 1 сек
    // 1. Сканирование уже началось (внутри секунды) - должен получить вместе с первым
    // 2. Сканирование продолжается, но дерево уже отправлено - отдать сразу

    // Всех подписчиков записать в список, чтобы им потом досылать данные
    scanClients.add(scanObj.uuid);

    if (scanStatus == 2) {
      scanTreeSend(scanObj.uuid);
    } else if (scanStatus == 0) {
      scanStart();
    }
  });

  function scanStart() {
    scanStatus = 1;
    scanTree = new Tree('/');

    // Подписаться. Через 1 сек после подписки отправить дерево
    // Потом будут добавления
    client.subscribe(scanTopic, err => {
      if (err) {
        plugin.log('ERROR subscribing: ' + util.inspect(err));
        scanStatus = 0;
      }
    });

    setTimeout(() => {
      const data = [scanTree.getTree()];
      scanClients.forEach(uuid => scanTreeSend(uuid, data));
      scanStatus = 2;
    }, 1000);
  }

  function scanTreeSend(uuid, data) {
    if (!data) data = [scanTree.getTree()];
    plugin.log('SEND SCAN TREE for ' + uuid + ': ' + util.inspect(data, null, 7));
    plugin.send({ type: 'scan', op: 'list', data, uuid });
  }

  function scanStop() {
    scanClients.clear();
    scanStatus = 0;
    scanTree = '';
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

  /**  act
   * Получил от сервера команду(ы) для устройства - отправить брокеру
   * @param {Array of Objects} - data - массив команд
   *                            В команде  должен быть topic и message
   */
  plugin.on('act', data => {
    if (!data) return;
    data.forEach(item => {
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
