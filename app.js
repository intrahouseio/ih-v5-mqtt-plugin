/**
 * app.js
 * Wraps a client connection to an MQTT broker
 */

const util = require('util');
const mqtt = require('mqtt');
// const pluginApi = require('ih-plugin-api')();

const converter = require('./lib/converter');
const Scanner = require('./lib/scanner');
// const { disconnect } = require('process');

module.exports = async function (plugin) {
  let buffer = {};
  let extraChannels = {};
  let clientState = 'offline';
  const scanner = new Scanner(plugin);

  // Подготовить каналы для подписки на брокере
  converter.createSubMap(plugin.channels);
  converter.createCmdMap(plugin.extraChannels);
  // Подготовить каналы для публикации - нужно подписаться на сервере IH на эти устройства
  subIhExtraChannels(converter.saveExtraGetFilter(plugin.extraChannels));

  function subIhExtraChannels(filter) {
    if (filter) {
      plugin.log('filter' + util.inspect(filter), 1);
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
              // let message = formMessage(pobj.message, item.value);
              if (pobj.bufferlength > 0) {
                message = JSON.stringify({ value: item.value, ts: Date.now() });
              } else {
                message = item.value.toString();
              }
              extraChannels[item.did] = { topic, message, options: pobj.options };
              // plugin.log('extraChannels ' + util.inspect(extraChannels));
              publishExtra(topic, message, pobj.options, pobj.bufferlength);
            } else {
              plugin.log('NOT found extra for ' + util.inspect(item), 1);
            }
          } catch (e) {
            const errStr = 'PUBLISH for ' + util.inspect(item) + ' ERROR: ' + util.inspect(e);
            plugin.log(errStr, 1);
          }
        });
      });

      // plugin.log('SEND: '+util.inspect({ type: 'sub', id: 'main', event: 'devices', filter }));
    }
  }

  let client = {};

  connect();

  function connect() {
    const {
      host,
      port,
      use_password,
      username,
      password,
      protocol,
      clean,
      clientId,
      willtopic,
      willpayload,
      willqos,
      willretain,
      useselfsigned,
      key,
      cert,
      ca
    } = plugin.params;
    const will = {};
    will.topic = willtopic || 'status';
    will.payload = willpayload || 'disconnected';
    will.qos = willqos;
    will.retain = willretain;

    let options;
    plugin.log('Params' + util.inspect(plugin.params), 1);
    if (clean == 1) {
      options = { host, port, protocol, will };
    } else {
      options = { host, port, protocol, clean, clientId, will };
    }

    let authStr = '';
    if (use_password) {
      Object.assign(options, { username, password });
      authStr = 'username = ' + username;
    }

    if (protocol == "mqtts" && useselfsigned) {
      const fs = require('fs');
      Object.assign(options, {
        key: fs.readFileSync(key),
        cert: fs.readFileSync(cert),
        ca: fs.readFileSync(ca),
        rejectUnauthorized: true
      });
    }

    plugin.log(`Start connecting ${protocol}: ${host}:${port} ${authStr}`, 1);
    try {
      client = mqtt.connect(options);
    } catch (e) {
      plugin.log("Connection error " + util.inspect(e), 1)
    }


    // Подключение успешно
    client.on('connect', () => {
      plugin.log('Connected', 1);
      clientState = 'connected';
      publish(plugin.params.willtopic, plugin.params.recoverypayload || 'connected', {
        retain: plugin.params.willretain,
        qos: plugin.params.willqos
      });
      for (let key in extraChannels) {
        publish(extraChannels[key].topic, extraChannels[key].message, extraChannels[key].options);
      }
      subscribe(converter.getSubMapTopics());
      subscribe(converter.getCmdMapTopics());
      subscribe(converter.getSubNodeMapTopics());

      for (let key in buffer) {
        publish(key, JSON.stringify(buffer[key].data), buffer[key].options);
      }
    });

    // Получены данные
    client.on('message', (topic, message) => {
      message = message.toString();
      plugin.log('GET: ' + topic + ' ' + message, 1);
      if (scanner.status > 0) {
        scanner.process(topic, message);
      }
      processMessage(topic, message);
    });

    // Ошибка
    client.on('error', async (err) => {
      //plugin.log('Host is offline', 1);
      clientState = 'error';
      const channels = await plugin.channels.get();
      await sendChstatus(1);
    });

    client.on('offline', async () => {
      //plugin.log('Host is offline', 1);
      clientState = 'offline';
      await sendChstatus(1);
    });

    client.on('disconnect', async () => {
      plugin.log('Broker disconected client', 1);
      clientState = 'disconnect';
      await sendChstatus(1);
    });

    client.on('reconnect', () => {
      plugin.log('Reconnecting', 1);
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

  async function sendChstatus(chstatus) {
    const channels = await plugin.channels.get();
    plugin.sendData(channels.map(item => ({ id: item.chan, chstatus })))
  }

  function processMessage(topic, message) {
    if (converter.startsceneMap.has(topic)) {
      converter.startsceneMap.get(topic).forEach(item => {
        plugin.send({ type: 'startscene', id: item, arg: { topic, message } });
      });
    }

    // На входе м б не JSON, а строка 
    // Здесь JSON.parse выполняется только чтобы отделить архивные данные от текущих
    // По умолчанию JSON массив рассматривается как архив
    // Флаг arrayAsData сообщает, что JSON массив - это обычные данные (не архив)
    let arch = false;
    if (!plugin.params.arrayAsData) {
      try {
        arch = Array.isArray(JSON.parse(message));
      } catch (e) {
        // plugin.log('Invalid JSON.parse: ' + message);
      }
    }

    let data;
    if (arch) {
      data = converter.convertIncomingArchive(topic, message);
    } else {
      data = converter.convertIncoming(topic, message, plugin);
    }

    if (data) {
      // Если value - это объект и нужно извлекать время - в каждом элементе извлечь время
      try {
        if (data[0] && data[0].cmditem) {
          plugin.log('Get command todo ' + util.inspect(data[0]), 2);
          formAndSendCommand(data[0]);
        } else {
          if (plugin.params.extract_ts && plugin.params.ts_field) processTimestamp(data, plugin.params.ts_field);
          if (arch) {
            plugin.sendArchive(data);
          } else {
            plugin.log("data " + util.inspect(data), 2)
            plugin.sendData(data);
          }
        }
      } catch (e) {
        plugin.log('Time process error, expected JSON with "' + plugin.params.ts_field + '" property', 1);
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

    plugin.log('SUBSCRIBE: ' + String(topics), 1);
    client.subscribe(topics, err => {
      if (err) {
        plugin.log('ERROR subscribing: ' + util.inspect(err), 1);
      }
    });
  }

  function unsubscribe(topics) {
    if (!topics) return;
    if (!Array.isArray(topics)) topics = [topics];

    plugin.log('UNSUBSCRIBE: ' + String(topics), 1);
    client.unsubscribe(topics, err => {
      if (err) {
        plugin.log('ERROR unsubscribing: ' + util.inspect(err), 1);
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
    client.publish(topic, message, options, (err) => {
      plugin.log('PUBLISH: ' + topic + ' ' + message + ' with options = ' + util.inspect(options), 2);
      if (err) {
        plugin.log('ERROR publishing topic = ' + topic + ': ' + util.inspect(err), 1);
      }
    });
  }

  function publishExtra(topic, message, options, bufferlength) {
    if (!topic || !message) return;
    if (clientState == 'connected') {
      client.publish(topic, message, options, (err) => {
        plugin.log('PUBLISH: ' + topic + ' ' + message + ' with options = ' + util.inspect(options), 2);
        if (err) {
          plugin.log('ERROR publishing topic = ' + topic + ': ' + util.inspect(err), 1);
          if (bufferlength > 0) {
            writebuffer(topic, message, options, bufferlength);
          }
        }
      });
    } else if (bufferlength > 0) {
      writeBuffer(topic, message, options, bufferlength);
    }
  }

  function writeBuffer(topic, message, options, bufferlength) {
    plugin.log('Buffer ADD: ' + topic + ': ' + message, 2);
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
    // plugin.log('Buffer ' + util.inspect(buffer[topic]), 2);
  }

  function addChannel(item) {
    if (!item.topic || !item.id) return;
    let newtopic;
    if (!item.parenttopic) {
      // Добавить топик в subMap; подписаться на него, если пока нет подписки
      newtopic = converter.addSubMapItem(item.topic, item.id);
    } else {
      // Добавить топик в subNodeMap; подписаться на него, если пока нет подписки
      newtopic = converter.addSubNodeMapItem(item.parenttopic, item.id, item.scriptfile);
    }
    if (newtopic) subscribe(newtopic);


  }

  function updateChannel(item) {
    if (!item.oldid || !item.id) return;
    if (!item.parenttopic) {
      const oldtopic = converter.findTopicById(item.oldid);
      if (oldtopic == item.topic) {
        // Изменилось только id - топик не дергать (subscribe/unsubscribe)
        if (item.oldid != item.id) {
          converter.deleteSubMapItem(item.topic, item.oldid);
          addChannel(item);
        }
        return;
      }
      // Топик изменился  
    } else {
      const oldtopic = converter.findNodeTopicById(item.oldid);
      if (oldtopic == item.parenttopic) {
        // Изменилось только id - топик не дергать (subscribe/unsubscribe)
        if (item.oldid != item.id) {
          converter.deleteSubNodeMapItem(item.parenttopic, item.oldid);
          addChannel(item);
        }

        return;
      }
    }
    deleteChannel(item);
    addChannel(item);
    
  }

  function deleteChannel(item) {
    if (!item.oldid) return;
    let restopicSubMap;
    let restopicSubNodeMap;
    let topic;
      topic = converter.findTopicById(item.oldid);
      restopicSubMap = converter.deleteSubMapItem(topic, item.oldid);
      topic = converter.findNodeTopicById(item.oldid);
      restopicSubNodeMap = converter.deleteSubNodeMapItem(topic, item.oldid);  
    if (restopicSubMap) {
      plugin.log('UNSUBSCRIBE: ' + restopicSubMap, 1);
      client.unsubscribe(restopicSubMap);
    }
    if (restopicSubNodeMap) {
      plugin.log('UNSUBSCRIBE: ' + restopicSubNodeMap, 1);
      client.unsubscribe(restopicSubNodeMap);
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
          item.ts = new Date(vobj[ts_field]).getTime();
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
      plugin.log('SUBSCRIBE: ' + scanTopic, 1);
      client.subscribe(scanTopic, err => {
        if (err) {
          plugin.log('ERROR subscribe on ' + scanTopic + ': ' + util.inspect(err), 1);
          scanner.stop();
        }
      });
    }
  }

  function scanStop() {
    const scanTopic = scanner.stop();
    // Отписаться и подписаться заново!!
    if (scanTopic) {
      plugin.log('UNSUBSCRIBE: ' + scanTopic, 1);
      client.unsubscribe(scanTopic, err => {
        if (!err) {
          // Заново подписаться на топики из каналов
          subscribe(converter.getSubMapTopics());
        } else {
          // plugin.log('ERROR unsubscribe on '+scanTopic +': '+ util.inspect(err));
          plugin.exit(1, 'ERROR unsubscribe on ' + scanTopic + ': ' + util.inspect(err), 1);
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
    plugin.log('ACT data=' + util.inspect(message), 1);
    if (!message.data) return;
    message.data.forEach(item => {
      try {
        const pubStr = publishAct(item);
        //plugin.log('PUBLISH ' + pubStr, 1);
      } catch (e) {
        const errStr = 'ERROR PUBLISH!! ERROR: ' + util.inspect(e);
        plugin.log(errStr, 1);
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
        if (!message.data) return plugin.log('Not found data: ' + util.inspect(message), 1);
        if (typeof message.data != 'object') return plugin.log('Invalid data: ' + util.inspect(message), 1);

        data = !Array.isArray(message.data) ? [message.data] : message.data;
        data.forEach(item => {
          try {
            if (item.topic) publish(item.topic, item.message || '', item.options || {});
          } catch (e) {
            const errStr = 'PUBLISH for ' + util.inspect(item) + ' ERROR: ' + util.inspect(e);
            plugin.log(errStr, 1);
          }
        });
        break;
      default:
        plugin.log('Missing or invalid command! Expected command:publish!', 1);
    }
  });

  // При изменении каналов, recs = {Array of Objects}
  plugin.onChange('channels', recs => {
    recs.forEach(rec => {
      if (rec.op == 'add') {
        plugin.log('onChange addChannels ' + util.inspect(recs), 2);
        addChannel(rec);
      } else if (rec.op == 'update') {
        plugin.log('onChange updateChannels ' + util.inspect(recs), 2);
        updateChannel(rec);
      } else if (rec.op == 'delete') {
        plugin.log('onChange deleteChannels ' + util.inspect(recs), 2);
        deleteChannel(rec);
      }
    });
    //plugin.log("SubMap " + util.inspect(converter.subMap))
    //plugin.log("NodeSubMap " + util.inspect(converter.subNodeMap))
  });

  plugin.onChange('extra', async recs => {
    plugin.log('onChange addExtra ' + util.inspect(recs), 2);
    unsubscribe(converter.getCmdMapTopics());
    plugin.extraChannels = await plugin.extra.get();
    converter.cmdMap.clear();
    converter.createCmdMap(plugin.extraChannels);
    subscribe(converter.getCmdMapTopics());
    subIhExtraChannels(converter.saveExtraGetFilter(plugin.extraChannels));
  });

  plugin.onChange("channelscript", recs => {
    recs.forEach(rec => {
      plugin.log('onChange channelscript ' + util.inspect(rec), 2);
      if (rec.scriptfile) {
        delete require.cache[require.resolve(rec.scriptfile)];
      }
    });
  })

  plugin.on('exit', () => {
    if (client) client.end();
  });

};
