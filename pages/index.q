
{meta}:
  title: Test

{use_asset}: script/jquery.js
{use_asset}: script/kb.js
{use_asset}: script/carreau.js

{js}:
    var data = (
        ["define", ["fib", "n"],
         ["cond",
          [["<=", "n", 1], 0],
          ["t", ["+", ["fib", ["-", "n", 1]], ["fib", ["-", "n", 2]]]]]]
    );

    var data = (
       ["body",
        ["define", ["", ["sym", "add"], ["sym", "x"], ["sym", "y"]],
         ["let", ["", ["", ["sym", "z"], ["num", 10]], ["", ["sym", "w"], ["str", "hello, my friends!"]]],
          ["", ["sym", "+"], ["sym", "x"], ["sym", "y"], ["sym", "z"], ["sym", "w"]]]]]
    );

    var data0 = (
        ["sym", "bloblo"]
    );

    //var n = create_structure(data);
    //var s = n.element;
    var framework = Framework(data);
    var root = framework.root;
    var s = root.element;
    $('#target').append(s);

    framework.interact.install(document);

    // $(document).keydown(framework._keydown);
    // $(document).keyup(framework._keyup);
    // $(document).keypress(framework._keypress);

    // interact = Interactor(1234);
    // bindings = {
    //     a: function(x) {console.log(x)},
    //     z: function(x) {console.log(x + 1)},
    //     "=(": function(x) {console.log("parens")},
    //     "C-p": function(x) {console.log("print")},
    //     "^C-p": function(x) {console.log("unprint")},
    // };
    // interact.set_bindings(bindings);

    // $(document).keydown(interact.keydown);
    // $(document).keyup(interact.keyup);
    // $(document).keypress(interact.keypress);


#target ..
