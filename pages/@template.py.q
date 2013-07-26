
{html}:[<!DOCTYPE html>]
html ..

  head ..
    meta [http-equiv = Content-type] [content = text/html; charset=UTF-8] ..
    {insert_document}: xlinks
    title ..
      {meta}: title
    {insert_document}: css

  body ..
    h1 .title ..
      {meta}: title
    #main ..
      {insert_document}: main

    #foot ..
      #powered .. Powered by Quaint::[http://breuleux.net/quaint]
    {insert_document}: js
    {insert_document}: errors
