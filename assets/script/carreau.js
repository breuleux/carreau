

function setEndOfContenteditable(contentEditableElement)
{
    // http://stackoverflow.com/questions/1125292/how-to-move-cursor-to-end-of-contenteditable-entity
    var range,selection;
    if(document.createRange)
    {
        range = document.createRange();
        range.selectNodeContents(contentEditableElement);
        range.collapse(false);
        selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
    else if(document.selection)
    {
        range = document.body.createTextRange();
        range.moveToElementText(contentEditableElement);
        range.collapse(false);
        range.select();
    }
}


function first_node(x) {
    while (x.hasChildNodes()) {
        x = x.childNodes[0];
    }
    return x;
}

function last_node(x) {
    while (x.hasChildNodes()) {
        // x = x.childNodes[x.childNodes.length - 1];
        x = x.childNodes[0];
    }
    return x;
}


function check_extremity(div) {
    // This will not work for multi-lines.
    var sel = window.getSelection();
    if (sel.extentNode === first_node(div)
        && sel.extentOffset == 0) {
        return 'start';
    }
    else {
        var last = last_node(div);
        if (sel.extentNode === last
            && sel.extentOffset == (last.length || 0)) {
            return 'end';
        }
    }
    return false;
}

function check_start(div) {
    return check_extremity(div) == 'start';
}

function check_end(div) {
    return check_extremity(div) == 'end';
}


function prevent(event) {
    event.preventDefault();
    event.stopPropagation();
}


function get_element(x) {
    t = typeof x;
    if (t == 'string' || t == 'number')
        return document.createTextNode(x);
    else
        return x.element;
}


function relayout(node, classes, init, addchild) {
    var e = node.element;
    while (e.firstChild)
        e.removeChild(e.firstChild);
    classes.splice(0, 0, 'layout-' + node.layout_name);
    e.className = classes.join(' ');
    var order = init(e) || [];
    var ch = node.children;
    var i;
    for (i = 0; i < ch.length; i++) {
        var elems = addchild(e, i, ch[i]);
        order = order.concat(elems);
    }
    chain(node, order);
}

function chain(node, members) {
    node.first = members[0];
    node.last = members[members.length - 1];
    if (node.isatom) {
        delete node.element.down;
    }
    else if (node.element.down === undefined
             || members.indexOf(node.element.down) == -1) {
        node.element.down = node.first;
    }
    for (var i = 0; i < members.length; i++) {
        var m = members[i];
        m.left = members[i - 1];
        m.right = members[i + 1];
        m.up = node.element;
        m.backup = m.left; // || (node.children.length == 1 ? node.holes[0] : members[i + 2]);
        if (m.insertion_point !== m) {
            if (m.right.insertion_point === m.right)
                m.insertion_point = m.right;
            else
                m.insertion_point = undefined;
        }
    }
}


function natural_navigation(f, h, e) {
    while (f[h] === undefined && f.up !== undefined) {
        f = f.up;
    }
    if (f[h] !== undefined)
        f = f[h];
    while (f.node && f.node[e] !== undefined) {
        f = f.node[e];
    }
    return f;
}


function insert_tagged(hole, tag) {
    var parent = hole.parent_node;
    var f = parent.framework;
    var newnode = Node(f, tag);
    parent.insert(hole.parent_index, newnode);
    f.switch_focus(newnode.holes[0]);
}

function insert_untagged(hole) {
    var parent = hole.parent_node;
    var f = parent.framework;
    var newnode = Node(f, '');
    parent.insert(hole.parent_index, newnode);
    f.switch_focus(newnode.tagelem);
}

function insert_symbol(hole, text) {
    var parent = hole.parent_node;
    var f = parent.framework;
    var newnode = Node(f, 'sym');
    newnode.append(text || '');
    parent.insert(hole.parent_index, newnode);
    f.switch_focus(newnode.element);
    setEndOfContenteditable(f.focused.true_focus);
}

function symbol_character(e) {
    var k = e.which;
    return ((k >= 60 && k <= 90)
            || (k >= 97 && k <= 122)
            || (k >= 48 && k <= 57)
            || [36, 37, 38, 42, 43, 45, 47, 94, 95, 33, 124, 126].indexOf(k) != -1)
}


var nav_bindings = {
    Up: 'up',
    Down: 'down',
    "C-Left": 'left',
    "C-Right": 'right',
    Left: 'deep_left',
    Right: 'deep_right',

    Space: 'right',
    Enter: 'right',

    "=All": function (f, e) {
        var target = f.focused.insertion_point;
        if (target && symbol_character(e)) {
            insert_symbol(target, String.fromCharCode(e.which));
            return 'break';
        }
    },
    "=#": function (f) {
        var target = f.focused.insertion_point;
        if (target)
            insert_untagged(target);
    },
    "=(": function (f) {
        var target = f.focused.insertion_point;
        if (target)
            insert_tagged(target, '');
    },

    "=)": ['up', 'right'],
};

function check_empty(framework) {
    var elem = framework.focused;
    var box = elem.true_focus || elem;
    // console.log([box, elem.backup])
    if (elem.backup &&
        (box.innerHTML == ''
         || box.innerHTML == '<br>')) {
        var newelem = elem.backup;
        var node = elem.node;
        framework.switch_focus(newelem);
        var parent = node.parent_node;
        parent.remove(node);
    }
    return true;
}

var symbol_bindings = {
    Left: function (framework) {
        var box = framework.focused.true_focus || framework.focused;
        if (!check_start(box)) {
            return "default";
        }
    },
    Right: function (framework) {
        var box = framework.focused.true_focus || framework.focused;
        if (!check_end(box)) {
            return "default";
        }
    },
    Esc: {
        "All": 'stick',
        "^All": 'stick',
        "=All": function (f, e) {
            return 'default';
        },
    },

    "=All": function (f, e) {
        if (symbol_character(e)) {
            return 'default';
        }
    },

    "^Backspace": check_empty,
    "Backspace": check_empty,
    "^Delete": check_empty,
    "Delete": check_empty,
};


var hole_bindings = {

    Backspace: function (f) {
        var foc = f.focused;
        var node = foc.parent_node;
        if (node.children.length == 0 && node.parent_node) {
            // a (<) b ==> a< b
            f.switch_focus(node.element.backup);
            node.parent_node.remove(node);
        }
        else if (node.children.length == 1 && foc.parent_index == 0) {
            // a (<x) b ==> a< x b
            f.switch_focus(node.element.backup);
            node.parent_node.replace(node, node.children[0]);
        }
        else {
            f.go("deep_left");
            return "default";
        }
    }
};





function merge_bindings() {
    var results = {};
    for (var i = arguments.length - 1; i >= 0; i--) {
        var bindings = arguments[i];
        for (key in bindings) {
            var new_binding = bindings[key];
            var existing = results[key];

            if (typeof new_binding == 'string'
                || typeof new_binding == 'function') {
                new_binding = [new_binding];
            }

            if ((!(new_binding instanceof Array))
                || (!(existing instanceof Array))
                || existing === undefined) {
                results[key] = new_binding;
            }
            else {
                results[key] = new_binding.concat(existing);
            }
        }
    }
    return results;
}



function plain_layout(node) {
    var ch = node.children;
    var ho = node.holes;
    var tag = node.tagelem;
    relayout(
        node, ['node-' + node.name],
        function (e) {
            e.appendChild(tag);
            // e.appendChild(document.createTextNode(node.tag));
            // if (ch.length == 0) {
                e.appendChild(ho[0]);
                return [ho[0]];
            // }
        },
        function (e, i) {
            var child = ch[i];
            var hole = ho[i + 1];
            var elem = get_element(child);
            e.appendChild(elem);
            e.appendChild(hole);
            return [elem, hole];
        }
    );
    tag.right = ho[0];
}


function create_plain(framework, tag) {
    var result = document.createElement(tag || 'div');
    result.onclick = function(event) {
        framework.switch_focus(result);
        prevent(event);
    };
    result._focus = function () {
        $(result).addClass('focus').focus();
    };
    result._unfocus = function () {
        $(result).removeClass('focus').blur();
    };
    result.bindings = nav_bindings;
    return result;
}


function create_editable(framework) {
    var result = create_plain(framework, 'div');
    result.contentEditable = true;
    var old_focus = result._focus;
    result._focus = function (fromright) {
        if (fromright) {
            setEndOfContenteditable(result);
        }
        old_focus();
    };
    result.bindings = [symbol_bindings, nav_bindings];
    return result;
}


function symbol_layout(node) {
    var ch = node.children;
    relayout(
        node, ['node-' + node.name],
        function (e) {},
        function (e, i) {
            var child = ch[i];
            var box = create_editable(node.framework);
            box.appendChild(get_element(child));
            e.appendChild(box);
            e._focus = box._focus;
            e._unfocus = box._unfocus;
            box.onclick = e.onclick;
            e.bindings = box.bindings; //[box.bindings, nav_bindings];
            e.true_focus = box;
            return [];
        }
    );
}

// function atom_layout(node) {
//     var ch = node.children;
//     relayout(
//         node, ['node-' + node.name],
//         function (e) {},
//         function (e, i) {
//             var child = ch[i];
//             e.appendChild(get_element(child));
//             return [];
//         }
//     );
// }



// function major(n) {
//     return function (node) {
//         var one = document.createElement('div');
//         var two = document.createElement('div');
//         one.className = 'major';
//         two.className = 'minor';
//         var ch = node.children;
//         var ho = node.holes;
//         relayout(
//             node, ['node-' + node.name],
//             function (e) {
//                 e.appendChild(one);
//                 e.appendChild(two);
//                 // one.appendChild(Hole(node, 0));
//             },
//             function (e, i) {
//                 var child = ch[i];
//                 var hole = ho[i + 1];
//                 var elem = get_element(child);
//                 if (i < n) {
//                     one.appendChild(elem);
//                     if (i < n - 1) {
//                         one.appendChild(hole);
//                     }
//                     else {
//                         two.appendChild(hole);
//                     }
//                 }
//                 else {
//                     two.appendChild(elem);
//                     two.appendChild(hole);
//                 }
//                 return [elem, hole];
//             }
//         )
//     }
// }


layouts = {
    // The various layouts associated to plain_layout differ by the
    // CSS associated to the class name.

    atom: symbol_layout,
    plain: plain_layout,
    // major1: major(1),
    // major2: major(2),

    horizontal: plain_layout,
    vertical: plain_layout,
    // side: major(1),

    define: plain_layout,
};

wheels = {
    normal: ['horizontal', 'vertical', 'side'],
    define: ['define'],
    // "-": ['side'],
    atom: ['atom'],
    sym: ['atom'],
};


function Hole(node, i) {
    var framework = node.framework;
    var result = create_plain(node.framework); //node.framework.create();
    result.className = 'insertion-point';
    result.parent_node = node;
    result.parent_index = i;
    result.element = result;
    result.insertion_point = result;
    result.bindings = [hole_bindings, nav_bindings];
    return result;
}

function Node(framework, tag) {

    var self = {
        tag: tag,
        changed: false,
        framework: framework,
        isatom: false,
        children: [],
        holes: [],
        element: create_plain(framework), //framework.create(),
        name: '',
        wheel: wheels.normal,
        wheel_index: 0,
        update_wheel: function() {
            var name = self.tag;
            self.name = name;
            var wheel = wheels[name];
            if (wheel === undefined) {
                wheel = wheels.normal;
            }
            if (wheel != self.wheel) {
                self.wheel = wheel;
                self.wheel_index = 0;
            }
        },
        layout: function() {
            self.update_wheel();
            var layout_name = self.wheel[self.wheel_index];
            var layout = layouts[layout_name];
            self.layout_name = layout_name;
            return layout;
        },
        build: function() {
            self.layout()(self);
        },
        insert: function(i, node) {
            node.parent_node = self;
            self.children.splice(i, 0, node);
            self.holes.push(Hole(self, self.children.length));
            self.build();
        },
        remove: function(node) {
            var i = self.children.indexOf(node);
            self.children.splice(i, 1);
            node.parent_node = undefined;
            self.holes.pop();
            self.build();
        },
        replace: function(node, newnode) {
            var i = self.children.indexOf(node);
            self.children[i] = newnode;
            newnode.parent_node = self;
            node.parent_node = undefined;
            self.build();
        },
        append: function(node) {
            node.parent_node = self;
            self.children.push(node);
            self.holes.push(Hole(self, self.children.length));
            self.build();
        }
    };

    var tagelem = create_editable(self.framework);
    tagelem.className = 'tag';
    tagelem.appendChild(document.createTextNode(self.tag));
    var old_unfocus = tagelem._unfocus;
    tagelem._unfocus = function (framework) {
        self.tag = tagelem.innerHTML;
        old_unfocus();
        self.build();
    }

    self.tagelem = tagelem;
    self.element.node = self;
    self.holes.splice(0, 0, Hole(self, 0));
    self.build();
    return self;
}



function Framework(root) {

    var framework = {

        Node: function(s) { return Node(framework, s); },

        go: function(direction) {
            var focused = framework.focused;
            var newfocus;
            var fromright;
            switch (direction) {
            case 'left':
                newfocus = focused.left;
                fromright = true;
                break;
            case 'deep_left':
                newfocus = natural_navigation(focused, 'left', 'last');
                fromright = true;
                break;
            case 'right':
                newfocus = focused.right;
                break;
            case 'deep_right':
                newfocus = natural_navigation(focused, 'right', 'first');
                break;
            case 'up':
                newfocus = focused.up;
                if (focused.up)
                    newfocus.down = focused;
                break;
            case 'down':
                newfocus = focused.down;
                break;
            }
            framework.switch_focus(newfocus, fromright);
        },

        interactor_functions: {
            deep_left: function () { framework.go('deep_left'); },
            deep_right: function () { framework.go('deep_right'); },
            left: function () { framework.go('left'); },
            right: function () { framework.go('right'); },
            up: function () { framework.go('up'); },
            down: function () { framework.go('down'); },
        },

        switch_focus: function(x, fromright) {
            if (x === undefined)
                return

            if (framework.focused) {
                framework.focused._unfocus();
            }
            framework.focused = x;
            x._focus(fromright);

            var new_bindings = x.bindings;
            if (new_bindings instanceof Array) {
                new_bindings = merge_bindings.apply(
                    null,
                    new_bindings.map(function (x) {return x.bindings || x;})
                )
            }
            framework.interact.set_bindings(new_bindings);
        },

        create_structure: function(data) {
            var t = typeof data;
            var result;
            if (t == 'string' || t == 'number') {
                result = '' + data; //framework.Atom(data);
            }
            else {
                result = framework.Node(data[0]);
                var i;
                for (i = 1; i < data.length; i++) {
                    result.append(framework.create_structure(data[i]));
                }
            }
            return result;
        },

        init: function(root) {
            framework.root = framework.create_structure(root);
        },
    }

    var interact = Interactor(framework);
    interact.set_bindings(nav_bindings);
    framework.interact = interact;
    framework.init(root);
    framework.switch_focus(framework.root.element);
    return framework;
}
