/**
 * scanner.js
 *  Сканирование топиков брокера для показа их в виде дерева
 *  Выполняется по запросу от клиентов (type:'scan')
 *  
 *  Механизм сканирования:
 *  - Выполняется подписка на все топики (#)
 *  - Все поступающие топики разбиваются по /
 *    Формируется дерево со структурой {id, title, children:[{id, title, chidren:[...]}]}
 *    Последний узел топика содержит в title элемент=message, и включает объект channel:{topic, chan<ид-р канала в системе>}
 *  
 *  - Через интервал ... первый вариант дерева отправляется клиенту в сообщении:
 *     { type: 'scan', op: 'list', data:[tree], uuid }
 * 
 *  - Дальнейшие изменения досылаются отдельно, дерево достраивается 
 *    Это изменения 2 типов:
 *    1. Добавление новых узлов (если нет флага retained, брокер пришлет топик, только когда устройство отправит)
 *      Каждый узел (новое поддерево в дереве) отправляется с указанием parentid:
 *      { type: 'scan', op: 'add', parentid:'', data:{id, title, children:[{id, title,..}]}}
 * 
 *    2. Изменение message. Топик уже существует, просто изм значение
 *       Эти данные буферизуются и отправляются раз в 250 мсек
 *       При этом для одинаковых топиков отправляется только последнее значение (если частота изм > 250 мсек)
 *        { type: 'scan', op: 'update', data:[{id, title}, {id, title},..] }
 *  
 *    Процесс продолжается, пока не происходит остановка сканирования (type:'scan', stop:1)
 *    При остановке 
 *     - выполняется отписка #
 *     - заново выполняется подписка на топики каналов
 *      
 *    Порядок обслуживания запросов от клиентов в процессе сканирования.
 *    !!процесс сканирования один, 
 *    - При первом запросе выполняется запуск процесса сканирования, uuid запроса помещается в this.clients
 *      Если в течение 1 этапа поступают еще запросы, uuid этих запросов добавляются в this.clients
 *      По истечении 1 сек, каждому клиенту из списка this.clients отправляется сообщение с деревом
 *      { type: 'scan', op: 'list', data:[tree], uuid } - явно указан uuid клиента
 *    - При поступлении следующего запроса на сканирование клиенту сразу отправляется такое же сообщение,
 *      которое содержит дерево на текущий момент, uuid запроса также добавляется в this.clients для досылки
 * 
 *    Досылка изменений выполняется одним сообщением без указания uuid, но с указанием scanid:'root' (в данном плагине всегда все сканируется)
 *    Это сделано, чтобы не отрабатывать отписки каждого отдельного клиента 
 *    Команда на остановку сканирования придет, когда не останется подписанных клиентов
 *    (это выполняет pluginengine)
 * 
 *  
 */

const util = require('util');

const Tree = require('./topicstree');

const scanTopic = '#';

class Scanner {
  constructor(plugin) {
    this.plugin = plugin;

    this.status = 0; // 0 - сканирование не активно, 1 - первоначальное построение дерева, 2 - досылка изменений
    this.clients = new Set(); // Список uuid клиентов сканирования
    this.updateMap = new Map(); // Буфер для update
  }

  // Обработка запроса на сканирование
  request(scanObj) {
    // this.status:
    // 0: Первый клиент на сканирование - все с начала - отправка будет через 1 сек
    // 1: Сканирование уже началось - получит дерево вместе с первым клиентом
    // 2: Сканирование продолжается, но дерево уже отправлено - текущее дерево отдать сразу

    // Всех подписчиков записать в список, чтобы им потом досылать данные
    this.clients.add(scanObj.uuid);

    if (this.status == 2) {
      this.sendTree(scanObj.uuid); // Дерево готово - сразу отправляем
    } else if (this.status == 0) {
      this.start();
      return scanTopic;
    }
  }

  // Запуск сканирования
  start() {
    this.status = 1;
    this.scanTree = new Tree('/');

    setTimeout(() => {
      const data = [this.scanTree.getTree()];
      this.clients.forEach(uuid => this.sendTree(uuid, data));
      this.status = 2;
    }, 1000);
  }

  sendTree(uuid, data) {
    if (!data) data = [this.scanTree.getTree()];
    // this.plugin.log('SEND SCAN TREE for ' + uuid + ': ' + util.inspect(data, null, 7));
    this.plugin.send({ type: 'scan', op: 'list', data, uuid });
  }

  // Обработка сообщения в процессе сканирования
  // Отправить на сервер толко scanid, pluginengine сам определяет uuid для досылки
  process(topic, message) {
    const result = this.scanTree.add(topic, message);
    if (this.status == 2) {
      // Дослать изменения
      const resObj = {};
      if (result.added) {
        resObj.op = 'add';
        resObj.data = result.added.data;
        resObj.parentid = result.added.parentid;
        this.plugin.send({ type: 'scan', ...resObj, scanid: 'root' });
        
      } else if (result.updated) {
        // Изменения буферизуются в this.updateMap и отправляются по таймеру
        if (!this.updateMap.size) {
          setTimeout(() => {
            const data = Array.from(this.updateMap.values());
            this.plugin.send({ type: 'scan', op: 'update', data, scanid: 'root' });
            this.updateMap.clear();
          }, 250);
        }
        this.updateMap.set(result.updated.id, result.updated);
      }
    }
  }

  // Останов сканирования
  stop() {
    this.clients.clear();
    this.status = 0;
    this.scanTree = '';
    return scanTopic;
  }
}

module.exports = Scanner;
