/**
 * app.js
 * Wraps a client connection to an MQTT broker
 */

const util = require('util');
const mqtt = require('mqtt');

const converter = require('./lib/converter');
const Scanner = require('./lib/scanner');

module.exports = async function(plugin) {
  let buffer = {};
  let clientState = 'offline';
  const scanner = new Scanner(plugin);

  // Подготовить каналы для подписки на брокере
  converter.createSubMap(plugin.channels);
  converter.createCmdMap(plugin.extra);

  // Подготовить каналы для публикации - нужно подписаться на сервере IH на эти устройства
  const filter = converter.saveExtraGetFilter(plugin.extra);
  if (filter) {
    
    // plugin.send({ type: 'sub', id: 'main', event: 'devices', filter });
    plugin.onSub('devices', filter, data => {
      if (!data) return;
      data.forEach(item => {
        // item: {did, prop, value}
        try {
          let pobj;
          if (item.did && item.prop) {
            pobj = converter.getPubMapItem(item.did + '.' + item.prop);
          }
          // let pobj = converter.convertOutgoing(item.did + '.' + item.prop, item.value);
          if (pobj && pobj.topic) {
            let topic = pobj.topic;
            let message = '';
            //let message = formMessage(pobj.message, item.value);
            if (pobj.bufferlength > 0) {
              message = JSON.stringify({value:item.value, ts:Date.now()});
            } else {
              message = item.value.toString();
            }
            publishExtra(topic, message, pobj.options, pobj.bufferlength);
            plugin.log('PUBLISH: ' + topic + ' ' + message + ' with options=' + util.inspect(pobj.options), 2);
          } else {
            plugin.log('NOT found extra for ' + util.inspect(item));
          }
        } catch (e) {
          const errStr = 'PUBLISH for ' + util.inspect(item) + ' ERROR: ' + util.inspect(e);
          plugin.log(errStr);
        }
      });
    });
    // plugin.log('SEND: '+util.inspect({ type: 'sub', id: 'main', event: 'devices', filter }));
  }

  let client = {};
  
  connect();

  function connect() {
    let { host, port, use_password, username, password, protocol, clean, clientId } = plugin.params;
    if (!protocol || protocol.length < 3) protocol = '';
    plugin.log("Params" + util.inspect(plugin.params));
    const options = { host, port, protocol, clean, clientId};
    let authStr = '';
    if (use_password) {
      Object.assign(options, { username, password });
      authStr = 'username = ' + username;
    }

    plugin.log(`Start connecting ${protocol}: ${host}:${port} ${authStr}`, 1);
    client = mqtt.connect(options);

    // Подключение успешно
    client.on('connect', () => {
      plugin.log('Connected', 1);
      clientState = 'connected';
      subscribe(converter.getSubMapTopics());
      subscribe(converter.getCmdMapTopics());
      for (let key in buffer) {
        publish(key, JSON.stringify(buffer[key].data), buffer[key].options);
        //plugin.log("topic:" + key + JSON.stringify(buffer[key].data) + buffer[key].options);
      }
    });

    // Получены данные
    client.on('message', (topic, message) => {
      message = message.toString();
      plugin.log('GET: ' + topic + ' ' + message);
      if (scanner.status > 0) {
        scanner.process(topic, message);
      }
      processMessage(topic, message);
    });

    // Ошибка
    client.on('error', err => {
      plugin.log('Host is offline');
      clientState = 'error';
      //plugin.exit(1, 'Connection error:  ' + JSON.stringify(err));
    });

    client.on('offline', () => {
      plugin.log('Host is offline');
      clientState = 'offline';
      //plugin.exit(1, 'Connection error: Host is offline');
      // 
    });

    client.on('disconnect', () => {
      plugin.log('Broker disconected client');
      clientState = 'disconnect';
      //plugin.exit(1, 'Connection error: Host is offline');
      // 
    });

    client.on('reconnect', () => {
      plugin.log('Reconnecting');
      //clientState = 'reconnect';
      //plugin.exit(1, 'Connection error: Host is offline');
      // 
    });

    // Сообщения от библиотеки для отладки
    /*
    client.on('packetsend', packet => {
      plugin.log('Packet send. cmd:' + packet.cmd, 2);
    });

    client.on('packetreceive', packet => {
      plugin.log('Packet receive. cmd: ' + packet.cmd, 2);
    });
    */
  }

  function processMessage(topic, message) {
    if (converter.startsceneMap.has(topic)) {
      converter.startsceneMap.get(topic).forEach(item => {
        plugin.send({ type: 'startscene', id: item, arg: { topic, message } });
      });
    }

    let data;
    let arch; 
    
    try {
      arch = Array.isArray(JSON.parse(message));
    } catch (e) {
      plugin.log('Invalid JSON.parse: '+message)
    }

    if (arch) {
      data = converter.convertIncomingArchive(topic, message);
    } else {
      data = converter.convertIncoming(topic, message);
    }
    
    if (data) {
      // Если value - это объект и нужно извлекать время - в каждом элементе извлечь время
      try {
        if (data[0] && data[0].cmditem) {
          plugin.log('Get command todo ' + util.inspect(data[0]));
          formAndSendCommand(data[0]);
        } else {
          if (plugin.params.extract_ts && plugin.params.ts_field) processTimestamp(data);
          if (arch) {
            plugin.sendArchive(data);
          } else {
            plugin.sendData(data);
          }
          
        }
      } catch (e) {
        plugin.log('Time process error, expected JSON with "' + plugin.params.ts_field + '" property');
      }
    }
  }

  function formAndSendCommand({ cmditem, topic, message }) {
    const { extype, did, prop } = cmditem;
    // Отправить команду
    if (extype == 'cmd') {
      plugin.send({ type: 'command', command: 'device', did, prop });
    } else if (extype == 'set') {
      plugin.send({ type: 'command', command: 'setval', did, prop, value: message });
    }
  }

  function subscribe(topics) {
    if (!topics) return;
    if (!Array.isArray(topics)) topics = [topics];

    plugin.log('SUBSCRIBE: ' + String(topics));
    client.subscribe(topics, err => {
      if (err) {
        plugin.log('ERROR subscribing: ' + util.inspect(err));
      }
    });
  }

  function publishAct(item) {
    // if (!item.topic) return;
    let topic = item.pubtopic;
    let message = item.value;
    if (!item.chanId && item.pubmessage) {
      // Старый вариант - до версии сервера 5.5.140
      message = formMessage(item.pubmessage, item.value);
    } else {
      message = removeBorderQuotes(String(message));
    }
    publish(topic, message);
    return topic + ' ' + message;
  }

  function formMessage(mes, value) {
    // if (!mes) mes = value;

    if (mes.indexOf('value') >= 0) {
      const func = new Function('value', 'return String(' + mes + ');');
      // plugin.log('FUNC=' + func.toString());
      return func(value) || '';
    }
    // Если без формулы - могло быть в кавычках - убрать кавычки
    return typeof mes == 'string' ? removeBorderQuotes(mes) : String(mes);
  }

  function removeBorderQuotes(str) {
    if (typeof str != 'string') return str;
    return str.startsWith('"') || str.startsWith("'") ? str.substr(1, str.length - 2) : str;
  }

  function publish(topic, message, options) {
    if (!topic || !message) return;
    client.publish(topic, message, options, function (err) {
      if (err) {
        plugin.log('ERROR publishing topic=' + topic + ': ' + util.inspect(err));
      }
    });
  }

  function publishExtra(topic, message, options, bufferlength) {
    if (!topic || !message) return;
    if (clientState == 'connected') {
      client.publish(topic, message, options, function (err) {
        if (err) {
          plugin.log('ERROR publishing topic=' + topic + ': ' + util.inspect(err));
          if (bufferlength > 0) {
            writebuffer(topic, message, options, bufferlength);
          }
        }
      });
    } else {
      if (bufferlength > 0) {
        writeBuffer(topic, message, options, bufferlength);
      }
    }
  }

  function writeBuffer (topic, message, options, bufferlength) {
    plugin.log('Buffer ADD' + topic + ': ' + message, 2);
    if (buffer[topic] == undefined) {
      buffer[topic] = {};
      buffer[topic].data = [];
      buffer[topic].options = options;
    }
    if (buffer[topic].data.length < bufferlength) {
      buffer[topic].data.push(message);
    } else {
      buffer[topic].data.shift();
      buffer[topic].data.push(message);
    }
    //plugin.log('Buffer ' + util.inspect(buffer[topic]), 2);
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
    if (restopic) {
      plugin.log('UNSUBSCRIBE: ' + restopic);
      client.unsubscribe(restopic);
    }
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
      plugin.log('SUBSCRIBE: ' + scanTopic);
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
      plugin.log('UNSUBSCRIBE: ' + scanTopic);
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
        const errStr = 'ERROR PUBLISH!! ERROR: ' + util.inspect(e);
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

  // При изменении каналов, recs = {Array of Objects}
  plugin.onChange('channels', recs => {
    // plugin.log('onChange '+util.inspect(recs))
    recs.forEach(rec => {
      if (rec.op == 'add') {
        addChannel(rec);
      } else if (rec.op == 'update') {
        updateChannel(rec);
      } else if (rec.op == 'delete') {
        deleteChannel(rec);
      }
    });
  });

  plugin.on('exit', () => {
    if (client) client.end();
  });
};
