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


module.exports = {
  subMap: new Map(),
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

  // Извлечение по формуле делает IH, для общего топика отправляем одно и то же сообщение для каждого id
  convertIncoming(topic, message) {
    if (this.subMap.has(topic)) {
      return this.subMap.get(topic).map(id => ({ id, topic, value: message }));
    }
  },

  // -------------Публикация на брокере данных устройства с IH:
  // this.pubMap (key=dn: {topic, calc, ...})
  saveExtraGetFilter(data) {
    if (data && Array.isArray(data)) {
      let res = [];
      this.extra = data;
      this.pubMap = new Map();

      // Будут добавлены только те у которых есть dn - т е для единичных объектов
      data.forEach(item => {
        if (this.addPubMapItem(item)) res.push(item.dn);
      });

      if (res.length > 0) return { dn: res.join(',') };
    }
  },

  addPubMapItem(item) {
    if (item.id && item.topic && item.dn) {
      if (item.calc) {
        item.calcfn = new Function('value', 'return ' + item.calc);
      }
      if (!this.pubMap.has(item.dn)) {
        this.pubMap.set(item.dn, item);
        return true;
      }
    }
  },

  convertOutgoing(dn, val) {
    if (!dn) return;

    if (!this.pubMap.has(dn)) return;

    let item = this.pubMap.get(dn);
    if (!item || !item.topic) return;

    // NOT catch calcfn throw
    let message = item.calcfn ? String(item.calcfn(val)) : String(val);
    if (message) return { topic: item.topic, message, options: { retain: item.retain, qos: item.qos } };
  }
};
