/**
 * agent.js
 *
 * Wraps a client connection to an MQTT broker
 */

// const util = require('util');
const EventEmitter = require('events');

const mqtt = require('mqtt');
const converter = require('./lib/converter');

class Agent extends EventEmitter {
  constructor() {
    super();
    this.params = { host: '127.0.0.1', port: 1883, use_password: false, username: '', password: '' };
    this.client = '';
  }

  connect() {
    const { host, port, use_password, username, password } = this.params;

    const options = { host, port };
    let authStr = '';
    if (use_password) {
      Object.assign(options, { username, password });
      authStr = 'username = ' + username;
    }

    this.emit('log', `Start connecting ${host}:${port} ${authStr}`, 1);
    this.client = mqtt.connect(options);

    // Подготовить каналы для подписки на брокере
    converter.createSubMap(this.channels);

    // Подготовить каналы для публикации - нужно подписаться на сервере IH на эти устройства
    const filter = converter.saveExtraGetFilter(this.extra);
    if (filter) this.emit('send', 'sub', { id: 'main', event: 'devices', filter });

    // Подключение успешно
    this.client.on('connect', () => {
      this.emit('log', 'Connected', 1);
      this.subscribe(converter.getSubMapTopics());
    });

    // Получены данные
    this.client.on('message', (topic, message) => {
      message = message.toString();
      this.emit('log', 'GET: ' + topic + ' ' + message, 2);

      if (converter.startsceneMap.has(topic)) {
        converter.startsceneMap.get(topic).forEach(item => {
          this.emit('send', { type: 'startscene', id: item, arg: { topic, message } });
        });
      }

      const data = converter.convertIncoming(topic, message);
      if (data) {
        // Если value - это объект и нужно извлекать время - в каждом элементе извлечь время
        try {
          if (this.params.extract_ts && this.params.ts_field) processTimestamp(data);
          this.emit('data', data);
        } catch (e) {
          this.emit('log', 'Time process error, expected JSON with "' + this.params.ts_field + '" property');
        }
      }
    });

    // Ошибка
    this.client.on('error', err => {
      this.emit('error', 'Connection error ' + JSON.stringify(err));
    });

    this.client.on('offline', () => {
      this.emit('error', 'Host is offline');
    });

    // Сообщения от библиотеки для отладки
    this.client.on('packetsend', packet => {
      this.emit('log', 'Packet send. cmd:' + packet.cmd, 2);
    });

    this.client.on('packetreceive', packet => {
      this.emit('log', 'Packet receive. cmd: ' + packet.cmd, 2);
    });
  }

  subscribe(topics) {
    if (!topics) return;
    this.emit('log', 'SUBSCRIBE: ' + topics.join(', '), 2);
    this.client.subscribe(topics, err => {
      if (err) {
        this.emit('log', 'ERROR subscribing: ');
      }
    });
  }

  publishAct(item) {
    if (!item.topic) return;
    // if (item.act == 'set' && (!item.message || item.message == 'value')) item.message = String(item.value);
    if (!item.message || item.message == 'value') item.message = String(item.value);

    const func = new Function('value', 'return `' + item.message + '`;');
    const message = func(item.value) || '';
    this.publish(item.topic, message);
    return item.topic + ' ' + message;
  }

  publishData(item) {
    let pobj = converter.convertOutgoing(item.dn, item.val);
    if (pobj) this.publish(pobj.topic, pobj.message, pobj.options);
    return pobj.topic + ' ' + pobj.message;
  }

  publish(topic, message, options) {
    if (!topic || !message) return;

    this.emit('log', 'PUBLISH: ' + topic + ' ' + message, 2);

    this.client.publish(topic, message, options, err => {
      if (err) {
        this.emit('log', 'ERROR publishing: ' + topic);
      }
    });
  }

  addChannel({ id, topic }) {
    if (!topic || !id) return;
    // Добавить топик в this.subMap; подписаться на него, если пока нет подписки
    const newtopic = converter.addSubMapItem(topic, id);
    if (newtopic) this.subscribe(newtopic);
  }

  updateChannel({ oldid, id, topic }) {
    if (!oldid || !id) return;

    const oldtopic = converter.findTopicById(oldid);
    if (oldtopic == topic) {
      // Изменилось только id - топик не дергать (subscribe/unsubscribe)
      if (oldid != id) {
        converter.deleteSubMapItem(topic, oldid);
        this.addChannel({ id, topic });
      }
      return;
    }

    // Топик изменился
    this.deleteChannel({ oldid });
    this.addChannel({ id, topic });
  }

  deleteChannel({ oldid }) {
    if (!oldid) return;
    
    const topic = converter.findTopicById(oldid);
    const restopic = converter.deleteSubMapItem(topic, oldid);
    if (restopic) this.client.unsubscribe(restopic);
  }

  end() {
    if (this.client) this.client.end();
  }
}

module.exports = Agent;

// Частные функции модуля
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
