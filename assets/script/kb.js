

var keynames = {
    8: "Backspace",
    9: "Tab",
    13: "Enter",
    16: "S-",
    17: "C-",
    18: "A-",
    27: "Esc",
    32: "Space",
    33: "PgUp",
    34: "PgDn",
    35: "End",
    36: "Home",
    37: "Left",
    38: "Up",
    39: "Right",
    40: "Down",
    45: "Insert",
    46: "Delete",
    48: "0",
    49: "1",
    50: "2",
    51: "3",
    52: "4",
    53: "5",
    54: "6",
    55: "7",
    56: "8",
    57: "9",
    65: "a",
    66: "b",
    67: "c",
    68: "d",
    69: "e",
    70: "f",
    71: "g",
    72: "h",
    73: "i",
    74: "j",
    75: "k",
    76: "l",
    77: "m",
    78: "n",
    79: "o",
    80: "p",
    81: "q",
    82: "r",
    83: "s",
    84: "t",
    85: "u",
    86: "v",
    87: "w",
    88: "x",
    89: "y",
    90: "z",
    112: "F1",
    113: "F2",
    114: "F3",
    115: "F4",
    116: "F5",
    117: "F6",
    118: "F7",
    119: "F8",
    120: "F9",
    121: "F10",
    122: "F11",
    123: "F12",
};


function prevent(event) {
    event.preventDefault();
    event.stopPropagation();
}


function Interactor(target) {

    var functions;
    if (target.interactor_functions !== undefined) {
        functions = target.interactor_functions;
    }
    else {
        functions = target;
    }

    var more_functions = {
        "default": function () {return "default"},
        "stick": function () {return "stick"},
        "break": function () {return "break"},
        "none": function () {return undefined},
    }

    var self = {

        current_bindings: null,
        global_bindings: null,

        set_bindings: function (new_bindings) {
            self.current_bindings = null;
            self.global_bindings = new_bindings;
        },

        // execute: function (command, event) {
        //     if (typeof command == "string") {
        //         return functions[command](event);
        //     }
        //     else {
        //         return command(target, event);
        //     }
        // },

        execute: function (commands, e) {
            if (typeof commands == "string") {
                var f = functions[commands] || more_functions[commands];
                return f(e);
            }
            else if (typeof commands == "function") {
                return commands(target, e);
            }
            else if (commands instanceof Array) {
                var result;
                for (var i = 0; i < commands.length; i++) {
                    result = self.execute(commands[i], e);
                    if (result == 'break') {
                        prevent(e);
                        break;
                    }
                    else if (result == 'default') {
                        break;
                    }
                    else if (result == 'ignore') {
                        continue;
                    }
                    else if (result === undefined) {
                        prevent(e);
                    }
                }
                return result;
            }
            else {
                // console.log('okie dokie');
                // console.log(commands);
                self.current_bindings = commands;
                return 'break stick';
            }
        },

        process_codes: function(codes, e) {

            var bindings = (self.current_bindings || self.global_bindings);
            // console.log(bindings);

            // console.log("===")
            // console.log(e)
            // console.log(bindings)
            // console.log("===")

            var just_modifiers;
            var commands = [];
            codes.forEach(function (code) {
                if (code.match(/^([ACS]-)+$/)) {
                    just_modifiers = true;
                }
                var command = bindings[code];
                if (command !== undefined)
                    commands.push(command);
            });

            // var just_modifiers = code.match(/^([ACS]-)+$/);
            // var commands = bindings[code];

            if (commands.length == 0) {
                if (self.current_bindings && self.current_bindings._eat) {
                    // We delete the sub-bindings, except for when we
                    // hit modifiers without any other key.
                    if (!just_modifiers) {
                        self.current_bindings = null
                    }
                    prevent(e);
                    return;
                }
                else if (self.current_bindings && self.current_bindings._browser) {
                    if (!just_modifiers) {
                        self.current_bindings = null
                    }
                    return;
                }
                else if (self.current_bindings && !just_modifiers) {
                    self.current_bindings = null;
                    return self.process_codes(code, e);
                }
                else {
                    return;
                }
            }
            
            var result = self.execute(commands, e);
            if (result === undefined || (result.match && result.match('break'))) {
                prevent(e);
            }

            if ((!(result && result.match && result.match('stick')))
                && self.current_bindings
                && !self.current_bindings._stick) {
                self.current_bindings = null;
            }
        },

        getcode: function(e) {
            var orig_code = (keynames[e.which] || "<"+e.which+">");
            var code = orig_code;
            if (e.shiftKey && orig_code != "S-")
                code = "S-" + code;
            if (e.altKey && orig_code != "A-")
                code = "A-" + code;
            if ((e.ctrlKey || e.metaKey) && orig_code != "C-")
                code = "C-" + code;
            return code;
        },

        keyup: function(e) {
            self.process_codes(["!^All", '^' + self.getcode(e), "^All"], e);
            // self.process_codes("^All", e);
        },

        keydown: function(e) {
            self.process_codes(["!All", self.getcode(e), "All"], e);
            // self.process_codes("All", e);
        },

        keypress: function(e) {
            var key = e.which;
            var code = '=' + String.fromCharCode(key);
            self.process_codes(["!=All", code, "=All"], e);
            // self.process_codes("=All", e);
        },

        install: function(element) {
            element.onkeydown = self.keydown;
            element.onkeyup = self.keyup;
            element.onkeypress = self.keypress;
        },
    }

    return self;
}


