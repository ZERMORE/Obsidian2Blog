---
title: "<% tp.file.title %>"
timestamp: <% tp.date.now("YYYY-MM-DD HH:mm:ssZ") %>
tags: []
description:
sensitive: false
top: 0
draft: true
type: jotting
locale: zh-cn
slug: "<% await tp.system.prompt('slug（小写英文、数字和连接号）') %>"
---

<% tp.file.cursor() %>
