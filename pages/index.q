
{use_asset}: script/jquery.js
{use_asset}: script/carreau.js

{js}:
    var data = (
        ["define", ["fib", "n"],
         ["cond",
          [["<=", "n", 1], 0],
          ["t", ["+", ["fib", ["-", "n", 1]], ["fib", ["-", "n", 2]]]]]]
    );
    //var n = create_structure(data);
    //var s = n.element;
    var framework = Framework(data);
    var root = framework.root;
    var s = root.element;
    $('#target').append(s);
    $(document).keydown(framework._keydown);
    $(document).keyup(framework._keyup);
    $(document).keypress(framework._keypress);
    //$(document).keydown(event_kp(n));

#target ..
