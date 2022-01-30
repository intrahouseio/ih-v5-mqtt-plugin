/**
 *
 * converter - object for convert incoming and outgoing messages (from topic to channel_id or dn and vice versa)
 *
 *  subMap   <topic>:<channel_id> - for incoming from broker
 *          Created from channels
 *          Maps topic, getted from broker, to channel_id for IH server
 *
 *  pubMap  <dn>:{topic, calc} - for outgoing to broker
 *          Created from extra
 *          Convert dn and value, getted from server, to topic and message for broker
 *
 */
const util = require('util');

module.exports = {
  subMap: new Map(),
  cmdMap: new Map(),
  pubMap: new Map(),
  startsceneMap: new Map(),

  // ------------- Входящие от брокера:
  // this.subMap(key=topic: [id1,id2, ..])  - один топик может присылать данные для нескольких каналов
  createSubMap(channels) {
    if (!channels || !Array.isArray(channels)) return;

    channels.forEach(item => {
      if (item.id && item.topic) {
        if (!this.subMap.has(item.topic)) this.subMap.set(item.topic, []);
        this.subMap.get(item.topic).push(item.id);

        if (item.startscene) {
          if (!this.startsceneMap.has(item.topic)) this.startsceneMap.set(item.topic, []);
          this.startsceneMap.get(item.topic).push(item.startscene);
        }
      }
    });
  },

  createCmdMap(extra) {
    if (!extra || !Array.isArray(extra)) return;

    extra.forEach(item => {
      if (item.id && item.topic && (item.extype != 'pub')) {
        if (!this.cmdMap.has(item.topic)) this.cmdMap.set(item.topic, []);
        this.cmdMap.get(item.topic).push(item);
      }
    });
  },

  // Добавление канала
  // Возвращает topic, если он новый (нужно сделать subscribe)
  addSubMapItem(topic, id) {
    let res;
    if (!this.subMap.has(topic)) {
      this.subMap.set(topic, []);
      res = topic;
    }
    // Добавить, если пока нет - id не должны повторяться!!
    this.subMap.get(topic).push(id);
    return res;
  },

  // Удаление канала
  // Возвращает topic, если нужно сделать unsubscribe
  deleteSubMapItem(topic, id) {
    if (!this.subMap.has(topic)) return;

    let res;
    const idArr = this.subMap.get(topic);
    const idx = idArr.indexOf(id);
    if (idx >= 0) {
      idArr.splice(idx, 1);
      if (!idArr.length) res = topic;
    }
    return res;
  },

  findTopicById(id) {
    for (const [topic, idArr] of this.subMap) {
      const idx = idArr.indexOf(id);
      if (idx >= 0) return topic;
    }
  },

  getSubMapTopics() {
    if (this.subMap && this.subMap.size > 0) return [...this.subMap.keys()];
  },

  getCmdMapTopics() {
    if (this.cmdMap && this.cmdMap.size > 0) return [...this.cmdMap.keys()];
  },

  convertIncomingArchive(topic, message) {
    if (this.subMap.has(topic)) {
      let res = [];
      const messageArr = JSON.parse(message);
      const id = this.subMap.get(topic);
      this.subMap.get(topic).forEach(id => {
        messageArr.forEach(item => res.push({ id: id, topic, value: item.value, ts: item.ts}));
      })
      return res.sort(function (a, b) {
        if (a.ts > b.ts) {
          return 1;
        }
        if (a.ts < b.ts) {
          return -1;
        }
        // a должно быть равным b
        return 0;
      });
    }
  },
  // Извлечение по формуле делает IH, для общего топика отправляем одно и то же сообщение для каждого id
  convertIncoming(topic, message) {
    if (this.subMap.has(topic)) {
      return this.subMap.get(topic).map(id => ({ id, topic, value: message }));
    }

    if (this.cmdMap.has(topic)) {
      // return this.cmdMap.get(topic).map(cmditem => ({ cmditem, topic, message }));
      let res;
      this.cmdMap.get(topic).forEach(cmditem => {
        if (!cmditem.message || cmditem.message == message) {
          res = [{ cmditem, topic, message }];
        }
      });
      return res;
    }

  },

  // -------------Публикация на брокере данных устройства с IH:
  // this.pubMap (key=dn: {topic, calc, ...})
  saveExtraGetFilter(data) {
    if (data && Array.isArray(data)) {
      let res = [];
      this.extra = data;
      

      // Будут добавлены только те у которых есть dn - т е для единичных объектов
      data.forEach(item => {
        if (item.extype == 'pub') {
        const key = this.addPubMapItem(item);
        if (key) res.push(key);
        }
      });
      if (res.length > 0) return { did_prop: res };
    }
  },

  addPubMapItem(item) {
    // if (item.topic && item.id_prop) {
    if (item.topic && item.did && item.prop) {

      const key = item.did+'.'+item.prop;
      if (!this.pubMap.has(key)) {
        item.options = {retain: !!item.retain, qos: item.qos> 0 ? Number(item.qos) : 0};
        this.pubMap.set(key, item);
        return key;
      }
    }
    /**
     *   {
    _id: 'd2jMs_Rte',
    unit: 'mqttclient1',
    id: '__b2dhsna6w',
    id_prop: 'd0051.state',
    topic: 'ihdevice/H105_1/state',
    message: 'value',
    retain: 1,
    qos: 1,
    bufferlength: 0
  }
     */
  },

  // НЕ ИСПОЛЬЗУЕТСЯ
  convertOutgoing(dn, val) {
    if (!dn) return;

    if (!this.pubMap.has(dn)) return;

    let item = this.pubMap.get(dn);
    if (!item || !item.topic) return;

    // NOT catch calcfn throw
    // let message = item.calcfn ? String(item.calcfn(val)) : String(val);
    return { topic: item.topic, message:item.message, options: { retain: !!item.retain, qos: Number(item.qos) } };
  },

  getPubMapItem(key) {
    if (!key) return;
    if (!this.pubMap.has(key)) return;

    return this.pubMap.get(key);
  }
};
