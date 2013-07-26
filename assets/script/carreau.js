

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
    // node.holes[0]._active = false;
    // for (var i = 0; i < node.children.length; i++) {
    // }
    // if (!members) {
    //     return;
    // }
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
        m.backup = m.left || (node.children.length == 1 ? node.holes[0] : members[i + 2]);
        // m._active = true;
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

function woop(event) {
    console.log(event);
}


function navigate(framework) {
    // Standard navigation
    return function(event) {
        var focused = framework.focused;

        function go(direction) {
            prevent(event);
            framework.go(direction);
            return true;
        }

        var code;
        if (event.type == 'keydown') {
            code = event.keyCode;
        }
        else {
            code = -event.charCode;
        }

        console.log(code);

        switch (code) {

        case -40:
            var newnode = Node(framework);
            var target = focused.right;
            target.parent_node.insert(target.parent_index, newnode);
            target.parent_node.framework.switch_focus(newnode.holes[0]);
            return true;

        case -41:
            framework.go('up');
            return go('right');

        // case 8:
        //     eee;

        case 13:
            return go('right');

        case 32:
            return go('right');

        case 37:
            if (event.ctrlKey)
                return go('left');
            else
                return go('deep_left');

        case 39:
            if (event.ctrlKey)
                return go('right');
            else
                return go('deep_right');

        case 38:
            return go('up');

        case 40:
            return go('down');
        }
    }
}


function plain_layout(node) {
    var ch = node.children;
    var ho = node.holes;
    relayout(
        node, ['node-' + node.name],
        function (e) {
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
}

function atom_layout(node) {
    var ch = node.children;
    relayout(
        node, ['node-' + node.name],
        function (e) {},
        function (e, i) {
            var child = ch[i];
            e.appendChild(get_element(child));
            return [];
        }
    );
}

function major(n) {
    return function (node) {
        var one = document.createElement('div');
        var two = document.createElement('div');
        one.className = 'major';
        two.className = 'minor';
        var ch = node.children;
        var ho = node.holes;
        relayout(
            node, ['node-' + node.name],
            function (e) {
                e.appendChild(one);
                e.appendChild(two);
                // one.appendChild(Hole(node, 0));
            },
            function (e, i) {
                var child = ch[i];
                var hole = ho[i + 1];
                var elem = get_element(child);
                if (i < n) {
                    one.appendChild(elem);
                    if (i < n - 1) {
                        one.appendChild(hole);
                    }
                    else {
                        two.appendChild(hole);
                    }
                }
                else {
                    two.appendChild(elem);
                    two.appendChild(hole);
                }
                return [elem, hole];
            }
        )
    }
}


layouts = {
    // The various layouts associated to plain_layout differ by the
    // CSS associated to the class name.
    atom: atom_layout,
    plain: plain_layout,
    major1: major(1),
    major2: major(2),

    horizontal: plain_layout,
    vertical: plain_layout,
    side: major(1),

    define: plain_layout,
};

wheels = {
    normal: ['horizontal', 'vertical', 'side'],
    define: ['define'],
    "-": ['side'],
    atom: ['atom'],
};


function Hole(node, i) {
    var framework = node.framework;
    var result = node.framework.create(); //document.createElement('div');
    result.className = 'insertion-point';
    result.parent_node = node;
    result.parent_index = i;
    result.element = result;
    var prev_kp = result.element._keypress;
    result.element._keypress = function (event) {
        // console.log(event.keyCode);

        if (event.charCode == 40) {
            var newnode = Node(framework);
            node.insert(i, newnode);
            node.framework.switch_focus(newnode.holes[0]);
            return true;
        }

        if (prev_kp(event)) {
            return true;
        }

        var newnode = Atom(framework, '');
        node.insert(i, newnode);
        node.framework.switch_focus(newnode.element);
        return true;
    };

    // result.onclick = function () {
    //     node.framework.switch_focus(result);
    // }
    return result;
}

function Node(framework) {

    var self = {
        changed: false,
        framework: framework,
        isatom: false,
        children: [],
        holes: [],
        element: framework.create(), //document.createElement('div'),
        name: '',
        wheel: wheels.normal,
        wheel_index: 0,
        // layout: 'plain',
        update_wheel: function() {
            var c = self.children[0];
            var name;
            if (c !== undefined && c.isatom) {
                name = c.children[0];
            }
            else {
                name = '';
            }
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
        append: function(node) {
            node.parent_node = self;
            self.children.push(node);
            self.holes.push(Hole(self, self.children.length));
            self.build();
        }
    };
    self.element.node = self;
    self.holes.splice(0, 0, Hole(self, 0));
    self.build();
    return self;
}

function Atom(framework, s) {
    var self = Node(framework);
    // self.element = document.createElement('textarea');
    self.element.contentEditable = true;

    var prev_kd = self.element._keydown;
    self.element._keydown = function (event) {
        var focused = framework.focused;

        if (event.ctrlKey) {
            prev_kd(event);
            return;
        }

        // console.log(event.keyCode);

        switch (event.keyCode) {

        case 37:
            if (check_start(focused))
                prev_kd(event);
            break;

        case 39:
            if (check_end(focused))
                prev_kd(event);
            break;

        default:
            prev_kd(event);
        }
    };

    self.element._keyup = function (event) {
        if (self.element.innerHTML == '') {
            var newelem = self.element.backup;
            self.framework.switch_focus(newelem);
            var parent = self.parent_node;
            parent.remove(self);
        }
    };

    self.element._unfocus = function () {
        self.children[0] = self.element.innerHTML;
        self.parent_node.build();
    };

    self.element._focus = function (fromright) {
        if (fromright) {
            setEndOfContenteditable(self.element);
        }
    }

    self.isatom = true;
    self.wheel = wheels.atom;
    self.update_wheel = function() {};
    self.append(s);
    return self;
}



function Framework(root) {

    var framework = {

        Node: function() { return Node(framework); },
        Atom: function(s) { return Atom(framework, s); },

        create: function(tag) {
            var result = document.createElement(tag || 'div');
            result.onclick = function(event) {
                framework.switch_focus(result);
                prevent(event);
            };
            result._keydown = navigate(framework);
            result._keyup = function () {};
            result._keypress = navigate(framework);
            result._focus = function () {};
            result._unfocus = function () {};
            return result;
        },

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

        switch_focus: function(x, fromright) {
            if (x === undefined)
                return

            $(framework.focused).removeClass('focus').blur();
            if (framework.focused) {
                framework.focused._unfocus();
            }

            $(x).addClass('focus').focus();
            x._focus(fromright);
            framework.focused = x;
        },

        create_structure: function(data) {
            var t = typeof data;
            var result;
            if (t == 'string' || t == 'number') {
                result = framework.Atom(data);
            }
            else {
                result = framework.Node();
                var i;
                for (i = 0; i < data.length; i++) {
                    result.append(framework.create_structure(data[i]));
                }
            }
            return result;
        },

        init: function(root) {
            framework.root = framework.create_structure(root);
        },

        _keydown: function(event) {
            if (framework.focused._keydown) {
                framework.focused._keydown(event);
            }
        },

        _keyup: function(event) {
            if (framework.focused._keyup) {
                framework.focused._keyup(event);
            }
        },

        _keypress: function(event) {
            if (framework.focused._keypress) {
                framework.focused._keypress(event);
            }
        }
    }

    framework.init(root);
    framework.switch_focus(framework.root.element);
    return framework;
}

function event_kp(node) {

    function switch_focus(x, fromright) {
        if (x === undefined)
            return
        $(focused).removeClass('focus').blur();
        $(x).addClass('focus').focus();
        focused = x;
        if (fromright && focused.contentEditable == 'true') {
            setEndOfContenteditable(focused);
        }
    }

    var focused;
    switch_focus(node.element);

    return function(event) {
        switch (event.keyCode) {
        case 65:
            console.log("== " + focused.innerHTML.length);
            console.log("== " + window.getSelection().extentOffset);
            break;

        case 37:
            if (event.ctrlKey) {
                prevent(event);
                switch_focus(focused.left, true);
            }
            else if (focused.contentEditable == 'true') {
                var sel = window.getSelection();
                if (sel.extentOffset == 0) {
                    prevent(event);
                    switch_focus(focused.left, true);
                }
            }
            else {
                prevent(event);
                switch_focus(focused.left, true);
            }
            break;

        case 39:
            if (event.ctrlKey) {
                prevent(event);
                switch_focus(focused.right);
            }
            else if (focused.contentEditable == 'true') {
                var sel = window.getSelection();
                if (sel.extentOffset == focused.innerHTML.length) {
                    prevent(event);
                    switch_focus(focused.right);
                }
            }
            else {
                prevent(event);
                switch_focus(focused.right);
            }
            break;

        case 38:
            switch_focus(focused.up);
            break;

        case 40:
            switch_focus(focused.down);
            break;
        }
        console.log(event);
    }
}


// function create_structure2(data) {
//     var result = document.createElement('div');
//     if (typeof data == 'string') {
//         result.className = 'symbol';
//         result.appendChild(document.createTextNode(data))
//     }
//     else if (typeof data == 'number') {
//         result.className = 'number';
//         result.appendChild(document.createTextNode(data))
//     }
//     else {
//         if ((typeof data[0]) == 'string')
//             result.className = data[0];
//         var i;
//         for (i = 0; i < data.length; i++) {
//             result.appendChild(create_structure(data[i]))
//         }
//     }
//     return result;
// }

