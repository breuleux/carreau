

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
    // classes.splice(0, 0, 'layout-' + node.layout_name);
    classes = classes.concat(compute_classes(['node', 'node-' + node.tag]));
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
    // h = 'left' or 'right'
    // e = 'first' or 'last'

    if (f.node && f.node[e] !== undefined) {
        return f.node[e];
    }
    while (f[h] === undefined && f.up !== undefined) {
        f = f.up;
    }
    if (f[h] !== undefined)
        f = f[h];
    return f;

    // // Previous version
    // while (f[h] === undefined && f.up !== undefined) {
    //     f = f.up;
    // }
    // if (f[h] !== undefined)
    //     f = f[h];
    // while (f.node && f.node[e] !== undefined) {
    //     f = f.node[e];
    // }
    // return f;
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

function insert_leaf(type, hole, text) {
    var parent = hole.parent_node;
    var f = parent.framework;
    var newnode = Node(f, type);
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
            || [36, 37, 38, 42, 43, 45, 46, 47, 94, 95, 33, 124, 126].indexOf(k) != -1)
}


var functionality = {
    insert_string: function (f) {
        var target = f.focused.insertion_point;
        if (target) {
            insert_leaf('str', target);
            return 'break';
        }
    },
    insert_symbol: function (f, e) {
        var target = f.focused.insertion_point;
        if (target && symbol_character(e)) {
            insert_leaf('sym', target, String.fromCharCode(e.which));
            return 'break';
        }
    },
    insert_hash: function (f) {
        var target = f.focused.insertion_point;
        if (target)
            insert_untagged(target);
    },
    insert_call: function (f) {
        var target = f.focused.insertion_point;
        if (target)
            insert_tagged(target, '');
    },
    wrap_current: function (f) {
        var node = f.focused.node;
        var newnode = Node(f, '');
        node.parent_node.replace(node, newnode);
        newnode.append(node);
        f.switch_focus(newnode.holes[0]);
    },
    rotate_wheel: function (f) {
        var foc = f.focused;
        var node;
        if (foc.is_hole) {
            node = foc.parent_node;
        }
        else {
            node = foc.node;
        }
        node.rotate_wheel();
        f.switch_focus(foc);
    }
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

    "C-a": function (f) {
        var ser = root.serialize();
        console.log(ser);
        document.getElementById("serial").innerHTML = JSON.stringify(ser, undefined, 2);
    },

    "C-l": functionality.rotate_wheel,
    "C-o": functionality.wrap_current,

    "=All": functionality.insert_symbol,
    '="': functionality.insert_string,
    "=#": functionality.insert_hash,
    "=(": functionality.insert_call,

    "=)": ['up', 'right'],

    "C-Backspace": function (f) {
        var node = f.focused.node;
        var bk = f.focused.backup;
        if (bk) {
            node.parent_node.remove(node);
            f.switch_focus(bk);
        }
    }
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
        // framework.switch_focus(newelem);
        var parent = node.parent_node;
        parent.remove(node);
        framework.switch_focus(newelem);
    }
    return true;
}

function symbol_character_policy(e) {
    if (e.type == "keydown") {
        return 'ignore';
    }
    else if (symbol_character(e)) {
        return "default";
    }
}

function string_character_policy(e) {
    if (e.type == "keypress" && e.which == 34) {
        return "finish";
    }
    else if (e.ctrlKey
             || (e.type == "keydown" && (e.which == 37 || e.which == 39))) {
        return "ignore";
    }
    else {
        return "default";
    }
}

function leaf_bindings_for(character_policy) {
    function ev(f, e) {
        var result = character_policy(e);
        if (result == "finish") {
            f.go("right");
            return "break";
        }
        else {
            return result;
        }
    }
    return {
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

        "!=All": ev,
        "!All": ev,

        "^Backspace": check_empty,
        "Backspace": check_empty,
        "^Delete": check_empty,
        "Delete": check_empty,
    };
}

var leaf_bindings = {
    sym: leaf_bindings_for(symbol_character_policy),
    num: leaf_bindings_for(symbol_character_policy),
    str: leaf_bindings_for(string_character_policy),
}



var hole_bindings = {
    Backspace: function (f) {
        var foc = f.focused;
        var node = foc.parent_node;
        if (node.children.length == 0 && node.parent_node) {
            // a (<) b ==> a< b
            var bk = node.element.backup;
            // f.switch_focus(node.element.backup);
            node.parent_node.remove(node);
            f.switch_focus(bk);
        }
        else if (node.children.length == 1 && foc.parent_index == 0) {
            // a (<x) b ==> a< x b
            var bk = node.element.backup;
            // f.switch_focus(node.element.backup);
            node.parent_node.replace(node, node.children[0]);
            f.switch_focus(bk);
        }
        else {
            f.go("deep_left");
            return "default";
        }
    },

    "C-o": function (f) {
        if (f.focused.right) {
            f.switch_focus(f.focused.right);
        }
        else {
            return "break";
        }
    },

    "C-Backspace": 'left'
};

var node_bindings = {
    Backspace: 'deep_left',
    Delete: 'deep_right'
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



function plain_layout() {

    var classes = compute_classes(arguments);

    return function(node) {
        var ch = node.children;
        var ho = node.holes;
        var tag = node.tagelem;
        // var ntag = 'node-' + node.tag
        tag.className = 'tag tag-' + node.tag;
        relayout(
            node, // [ntag].concat(entailments[ntag] || []).concat(classes),
            classes, //.concat(compute_classes([ntag])),
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
}


function create_plain(framework, tag) {
    var result = document.createElement(tag || 'div');
    result.onclick = function(event) {
        framework.switch_focus(result);
        prevent(event);
    };
    result._focus = function () {
        var up = framework.focused.up;
        if (up) {
            $(up).addClass('focus2');
        }
        $(result).addClass('focus').focus();
    };
    result._unfocus = function () {
        var up = framework.focused.up;
        if (up) {
            $(up).removeClass('focus2');
        }
        $(result).removeClass('focus').blur();
    };
    result.bindings = [node_bindings, nav_bindings];
    return result;
}


function create_editable(framework, type) {
    var result = create_plain(framework, 'div');
    result.contentEditable = true;

    var old_focus = result._focus;
    result._focus = function (fromright) {
        if (fromright) {
            setEndOfContenteditable(result);
        }
        old_focus();
    };

    var old_unfocus = result._unfocus;
    result._unfocus = function() {
        result.change(result.innerHTML);
        old_unfocus();
    };

    result.bindings = [leaf_bindings[type], nav_bindings];
    return result;
}



var entailments = {
    // Extra classes to attach to certain nodes
    "node-sym": ["atom"],
    "node-num": ["atom"],
    "node-str": ["atom"],
}

function compute_classes(classes) {
    var results = [];
    for (var i = 0; i < classes.length; i++) {
        var cls = classes[i];
        results.push(cls);
        var ent = entailments[cls];
        if (ent)
            results = results.concat(ent)
    }
    return results;
}


function symbol_layout() {

    var classes = compute_classes(arguments);

    // var classes = ['node'];
    // for (var i = 0; i < arguments.length; i++) {
    //     var cls = arguments[i];
    //     classes.push(cls);
    //     var ent = entailments[cls];
    //     if (ent)
    //         classes = classes.concat(ent)
    // }

    return function (node) {
        // var ntag = 'node-' + node.tag
        var ch = node.children;
        relayout(
            // node, [ntag].concat(entailments[ntag] || []).concat(classes),
            node,
            classes, //.concat(compute_classes([ntag])),
            function (e) {},
            function (e, i) {
                var child = ch[i];
                var box = create_editable(node.framework, node.tag);
                box.appendChild(get_element(child));
                e.appendChild(box);
                e._focus = box._focus;
                e._unfocus = box._unfocus;
                box.onclick = e.onclick;
                e.bindings = box.bindings; //[box.bindings, nav_bindings];
                e.true_focus = box;
                e.parent_node = node.parent_node;
                box.parent_node = node.parent_node;
                box.change = function (x) {
                    node.replace(child, x);
                    child = x;
                    // ch[i] = x;
                };
                return [];
            }
        );
    };
}


function structural() {
    var groups = [];
    var nums = [];
    for (var i = 0; i < arguments.length; i++) {
        var ai = arguments[i];
        if (i) nums.push(ai[0]);
        groups.push(compute_classes(ai.slice(i && 1)));
    }

    return function (node) {
        var divs = [];
        for (var i = 0; i < nums.length; i++) {
            var div = document.createElement('div');
            divs.push(div);
            div.className = groups[i + 1].join(" ");
        }

        var ch = node.children;
        var ho = node.holes;
        var tag = node.tagelem;
        tag.className = 'tag tag-' + node.tag;
        var current = 0;
        var counter = 0;

        relayout(
            node, // ['node', ],
            groups[0], //.concat(compute_classes([ntag])),
            function (e) {
                for (var i = 0; i < nums.length; i++) {
                    e.appendChild(divs[i])
                }
                divs[current].appendChild(tag);
                counter++;
                while (counter >= nums[current]) {
                    current++;
                    counter = 0;
                }
                divs[current].appendChild(ho[0]);
                return [ho[0]];
            },
            function (e, i) {
                var child = ch[i];
                var hole = ho[i + 1];
                var elem = get_element(child);
                divs[current].appendChild(elem);
                counter++;
                while (counter >= nums[current]) {
                    current++;
                    counter = 0;
                }
                divs[current].appendChild(hole);
                return [elem, hole];
            }
        )
        tag.right = ho[0];
    }
}


layouts = {
    // The various layouts associated to plain_layout differ by the
    // CSS associated to the class name.

    atom: symbol_layout(),

    plain: plain_layout(),

    horizontal: plain_layout('horizontal'),
    vertical: plain_layout('vertical'),
    side: structural(['horizontal', 'centered'],
                     [2, 'horizontal'],
                     [Infinity, 'vertical']),

    hcall: plain_layout('horizontal', 'call'),
    vcall: plain_layout('vertical', 'call'),
    sidecall: structural(['horizontal', 'centered'],
                         [2, 'horizontal', 'call'],
                         [Infinity, 'vertical']),

    control: structural(['vertical', 'stretched'],
                        [2, 'spec', 'horizontal', 'centered'],
                        [Infinity, 'vertical', 'body']),
};

wheels = {
    normal: ['horizontal', 'vertical', 'side'],
    "": ['hcall', 'vcall', 'sidecall'],

    body: ['vertical'],
    define: ['control'],
    "let": ['control'],

    sym: ['atom'],
    num: ['atom'],
    str: ['atom'],
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
    result.is_hole = true;
    return result;
}

function set_parent(node, parent, index) {
    if (node.set_parent) {
        node.set_parent(parent, index)
    }
    else {
        node.parent_node = parent;
    }
}

function serialize(node) {
    if (typeof node == 'string')
        return node;
    else
        return node.serialize();
}

function reference(node) {
    if (typeof node == 'string')
        return ['serial', node];
    else
        return node.reference();
}

function Node(framework, tag) {

    var self = {
        changed: false,
        framework: framework,
        isatom: false,
        children: [],
        holes: [],
        element: create_plain(framework), //framework.create(),
        name: '',
        wheel: wheels.normal,
        wheel_index: 0,
        rotate_wheel: function() {
            self.wheel_index++;
            self.wheel_index %= self.wheel.length;
            if (self.wheel_index < 0) {
                self.wheel_index += self.wheel.length;
            }
            self.build();
        },
        set_parent: function(parent, index) {
            self.parent_node = parent;
            // self.parent_index = index;
            self.element.parent_node = parent;
        },
        coordinates: function() {
            var parent = self.parent_node;
            if (parent === 'root') {
                return [];
            }
            else if (parent === undefined) {
                return undefined;
            }
            var result = self.parent_node.coordinates();
            if (result !== undefined)
                result.push(parent.children.indexOf(self));
            return result;
        },
        reference: function() {
            var coord = self.coordinates();
            if (coord) {
                return ['coord', coord];
            }
            else {
                return ['serial', self.serialize()];
            }
        },
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

        serialize: function() {
            var result = self.children.map(serialize);
            result.splice(0, 0, self.tag);
            return result;
        },

        insert: function(i, node) {
            self.framework.report('insert', reference(self), i, reference(node));
            set_parent(node, self);
            self.children.splice(i, 0, node);
            self.holes.push(Hole(self, self.children.length));
            self.build();
        },
        remove: function(node) {
            var i = self.children.indexOf(node);
            self.framework.report('remove', reference(self), i);
            self.children.splice(i, 1);
            set_parent(node, undefined);
            self.holes.pop();
            self.build();
        },
        replace: function(node, newnode) {
            var i = self.children.indexOf(node);
            self.framework.report('replace', reference(self), i, reference(newnode));
            self.children[i] = newnode;
            set_parent(newnode, self);
            set_parent(node, undefined);
            self.build();
        },
        append: function(node) {
            self.framework.report('insert', reference(self),
                                  self.children.length, reference(node));
            set_parent(node, self);
            self.children.push(node);
            self.holes.push(Hole(self, self.children.length));
            self.build();
        },
        set_tag: function(newtag) {
            self.framework.report('set_tag', reference(self), newtag);
            self.tag = newtag;
        }
    };

    self.set_tag(tag);

    var tagelem = create_editable(self.framework, 'sym');
    tagelem.appendChild(document.createTextNode(self.tag));
    tagelem.change = function(x) {
        self.set_tag(x);
        self.build();
    };

    self.tagelem = tagelem;
    self.element.node = self;
    self.holes.splice(0, 0, Hole(self, 0));
    self.build();
    return self;
}



function Framework(root, report) {

    var framework = {

        Node: function(s) { return Node(framework, s); },

        report: report,
        // function(action, coordinates, parameters) {
        //     var args = Array.prototype.slice.call(arguments, 0);
        //     if (coordinates[0] == 'coord')
        //         console.log(JSON.stringify(args));
        // },

        go: function(direction) {
            var focused = framework.focused;
            var provenance = focused.provenance || {};
            var newfocus;
            var fromright;
            switch (direction) {
            case 'left':
                newfocus = provenance['right'] || focused.left;
                fromright = true;
                break;
            case 'deep_left':
                newfocus = (provenance['deep_rignt']
                            || natural_navigation(focused, 'left', 'last'));
                fromright = true;
                break;
            case 'right':
                newfocus = provenance['left'] || focused.right;
                break;
            case 'deep_right':
                newfocus = (provenance['deep_left']
                            || natural_navigation(focused, 'right', 'first'));
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
            // if (newfocus)
            //     newfocus.provenance[direction] = focused;
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
            x.provenance = {};
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

        create_structure: function(data, parent) {
            var t = typeof data;
            var result;
            if (t == 'string' || t == 'number') {
                result = '' + data; //framework.Atom(data);
            }
            else {
                result = framework.Node(data[0]);
                result.parent_node = parent;
                result.set_tag(data[0]);
                var i;
                for (i = 1; i < data.length; i++) {
                    result.append(framework.create_structure(data[i]));
                }
            }
            return result;
        },

        init: function(root) {
            framework.root = framework.create_structure(root, 'root');
        },
    }

    var interact = Interactor(framework);
    interact.set_bindings(nav_bindings);
    framework.interact = interact;
    framework.init(root);
    framework.switch_focus(framework.root.element);
    return framework;
}




function fetch(root, coord) {
    if (coord[0] == 'coord') {
        var coord = coord[1];
        var target = root;
        while (coord.length) {
            target = target[coord.shift() + 1];
        }
        return target;
    }
    else {
        return coord[1];
    }
}

function update(data, c) {
    var action = c[0];
    var target = fetch(data, c[1]);
    switch (action) {
    case 'set_tag':
        target.splice(0, 0, c[2]);
        break;
    case 'insert':
        target.splice(c[2] + 1, 0, fetch(data, c[3]));
        break;
    case 'remove':
        target.splice(c[2] + 1, 1);
        break;
    case 'replace':
        target[c[2] + 1] = fetch(data, c[3]);
        break;
    }
}

function report(action, coordinates) {
    if (coordinates[0] == 'coord') {
        var args = Array.prototype.slice.call(arguments, 0);
        update(data2, args);
        $("#json").empty().text(JSON.stringify(data2));
        show("#show", data2, function(){});
    }
}
