/**
 *
 */

class Tree {
  constructor(id) {
    this.tree = new Node(id);
  }

  add(topic, message) {
    let updated;
    let added;
   
    const parts = topic.split('/').filter(el => el);
    parts.reduce((r, b, idx) => {
      let node = r.getChild(b);
      let lastPart = parts.length-1 == idx;
      if (!node) {
        node = new Node(b, r.id, lastPart, message);
       if (lastPart) {
         const chan = parts.join('_').replace(/\s+/g,'_').replace(/[',\-,"]/g,'_')
        // node.channel = {topic, chan:parts.join('_') };
        node.channel = {topic, chan };
       }
        if (!r.children) r.children = []; 
        r.children.push(node);
        if (!added) {
          added = {parentid:r.id, data:node};
        }

      } else if (lastPart) {
        // Узел уже есть - м б изменение значения
        node.title = node.pid+' = '+message;
        updated = {id:node.id, title:node.title}
      }
      return node;
    }, this.tree);
    return {updated, added};
  }

  getTree() {
    return this.tree;
  }
}

module.exports = Tree;

class Node {
  constructor(pid, parentId, leaf, message) {
    this.pid = pid;
    this.id = parentId ? parentId+(parentId == '/' ? '' : '/')+this.pid : this.pid;
    if (leaf) {
      this.title = pid+' = '+message;
    } else {
      this.title = pid;
      this.children = [];
    }
  }

  getChild(pid) {
    let node;
    if (!this.children) return;
    this.children.some(n => {
      if (n.pid === pid) node = n;
      return !!node;
    });
    return node;
  }
}
