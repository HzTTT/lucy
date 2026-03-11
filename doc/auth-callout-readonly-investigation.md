# Auth Callout 只读调研说明

这份文档基于一次**只读排查**整理而成。

- 没有修改远端服务器
- 没有重启任何服务
- 只读取了源码、systemd 配置、NATS 配置和日志

目标是用小白也能看懂的方式，解释 `auth-callout` 这个服务在你当前架构里到底做了什么。

## 一句话结论

`auth-callout` 是你这套 NATS 架构里的“门卫 + 临时通行证签发器”。

- 门卫：判断一个连接进来的客户端是谁
- 通行证签发器：给它签发一张**临时 JWT 权限卡**
- NATS 服务器拿到这张卡后，才决定这个客户端能发哪些 subject、能订阅哪些 subject

所以：

- 文本消息能不能发
- 设备能不能互相收消息
- 媒体能不能上传到 JetStream Object Store

这些最终都不是由客户端自己决定的，而是由 `auth-callout` 给它签发的权限决定的。

## 这次只读看了哪些东西

远端机器：

- `116.207.140.203:19993`

读过的关键文件：

- `/etc/nats/nats-server.conf`
- `/etc/systemd/system/auth-callout.service`
- `/home/ubuntu/npc_im_server/auth-callout/main.go`
- `/home/ubuntu/npc_im_server/auth-callout/README.md`
- `/home/ubuntu/npc_im_server/deploy/README.md`
- `/home/ubuntu/npc_im_server/deploy/nats-server.conf`

看过的运行状态：

- `journalctl -u auth-callout.service`

## 先把几个术语说人话

### 1. NATS Subject

可以把它理解成“消息频道名”或者“消息地址”。

比如：

- `cephalon.im.npc.demo_user.2031655882831360000.client`
- `cephalon.im.npc.demo_user.2031655882831360000.machine`

客户端能不能往这些地址发消息、能不能订阅这些地址，靠权限控制。

### 2. NATS Account

可以把它理解成 NATS 内部的“租户 / 命名空间”。

你现在的配置里有 3 个 account：

- `AUTH`：专门给鉴权服务自己用
- `APP`：业务客户端用
- `SYS`：系统级服务用

### 3. JWT

这里的 JWT 不是网页登录那个概念，而是 NATS 用来描述“这个连接拥有哪些权限”的签名票据。

你可以把它理解成：

- 谁：这个连接代表谁
- 属于哪个 account：`APP` / `SYS`
- 能发哪些 subject
- 能收哪些 subject
- 有效期多久

### 4. Auth Callout

这是 NATS 的一个机制：

- 当客户端来连接时
- NATS 不直接放行
- 它会先把“这次连接的资料”发给一个外部服务
- 这个外部服务返回一张签好名的权限 JWT
- NATS 再按这张 JWT 放行

你现在的 `auth-callout` 就是这个外部服务。

## 当前部署长什么样

### NATS 本体

当前 NATS 不是 Docker 里跑的，而是宿主机 systemd 服务。

服务进程：

- `/usr/local/bin/nats-server -c /etc/nats/nats-server.conf`

监听方式：

- NATS 主服务监听 `127.0.0.1:14222`
- 监控端口是 `8222`
- WebSocket 监听 `127.0.0.1:8223`
- 外部访问通过 Nginx 代理出去

### Auth Callout 服务

systemd 配置显示：

- 工作目录：`/home/ubuntu/npc_im_server/auth-callout`
- 可执行文件：`/home/ubuntu/npc_im_server/auth-callout/auth-callout`
- 服务名：`auth-callout.service`

它启动时会带这些关键环境变量：

- `NATS_URL=nats://auth:auth@127.0.0.1:14222`
- `AUTH_USER=auth`
- `AUTH_PASS=auth`
- `AUTH_ISSUER_SEED=...`
- `APP_ACCOUNT=APP`
- `SYS_ACCOUNT=SYS`
- `AUTH_ACCOUNT=AUTH`

意思是：

- 它自己先用 `AUTH` account 下的 `auth/auth` 去连接本机 NATS
- 然后订阅 NATS 规定好的鉴权请求 subject
- 再用 `AUTH_ISSUER_SEED` 对权限 JWT 进行签名

## NATS 主配置里，auth-callout 是怎么接进去的

当前 `/etc/nats/nats-server.conf` 里有几件关键事：

### 1. 定义了 3 个 account

- `AUTH`
- `APP`
- `SYS`

其中：

- `AUTH` 下面有固定用户 `auth/auth`
- `APP` 开启了 JetStream

### 2. 开启了 auth_callout

配置里有：

```conf
authorization {
  auth_callout {
    issuer: "AB..."
    auth_users: [ "auth" ]
    account: "AUTH"
  }
}
```

它的含义是：

- NATS 只信任某个 `AB...` 公钥签出来的鉴权响应
- 真正负责生成这个响应的服务，运行在 `AUTH` account 里
- 允许 `auth` 这个用户来做鉴权服务

### 3. 暴露了一个 whoami 服务

当前配置还做了一件事：

- `AUTH` account 导出了 `cephalon.auth.whoami`
- `APP` account 导入了这个服务

这意味着业务侧客户端虽然在 `APP` account 里，也可以请求 `cephalon.auth.whoami` 这个服务，来得到“我是谁”的结果。

## auth-callout 源码的整体逻辑

下面按启动到响应完整走一遍。

### 第 1 步：服务启动

`main()` 会做这些事：

1. 读取环境变量
2. 用 `AUTH_ISSUER_SEED` 生成签名密钥
3. 连接本机 NATS
4. 订阅两个 subject

订阅的两个 subject 是：

- `$SYS.REQ.USER.AUTH`
- `cephalon.auth.whoami`

含义：

- `$SYS.REQ.USER.AUTH`：给 NATS 服务器做连接鉴权
- `cephalon.auth.whoami`：给业务客户端做“我是谁”查询

### 第 2 步：有客户端来连接 NATS

当有人连接 NATS 时，NATS 会把这次连接信息丢给 `$SYS.REQ.USER.AUTH`。

`auth-callout` 收到后执行 `handleAuthRequest()`。

它内部顺序是：

1. 解析 NATS 发来的鉴权请求 JWT
2. 从连接参数里提取身份信息
3. 做一次“身份决定”
4. 做一次“用户映射 / 校验”
5. 生成用户权限 JWT
6. 把结果回给 NATS

### 第 3 步：决定这是什么类型的连接

`decideIdentity()` 里把连接分成 3 类：

#### `sys`

如果用户名是 `presence_bridge`，就认为它是系统服务。

这是给系统桥接服务留的特殊通道。

#### `user`

如果连接里带了 `auth_token`，就归类为 `user`。

这类连接通常是：

- App 客户端
- WebSocket 客户端
- 直接拿 token 连接 NATS 的业务侧客户端

#### `npc`

如果连接里没有 token，但有：

- `username = apiKey`
- `password = deviceId`

那就归类为 `npc`。

这类更像“设备 / 机器人 / 网关实例”。

### 第 4 步：做身份映射

当前代码不是正式生产鉴权，而是一个**假鉴权版本**，函数叫 `fakeValidate()`。

它不查数据库，也不调用 HTTP 接口，而是做“固定映射”：

#### `user`

- `token_user1 -> user_id_1`
- `token_user2 -> user_id_2`
- 其他 token -> `user_<hash>`

#### `npc`

- `sk-apikey -> user_id_1`
- 其他 apiKey -> `user_of_<hash>`

所以你现在的 token 被映射成了：

- `user_211b3f142e`

这个结果也能从系统日志里看到。

## 权限 JWT 是怎么生成的

这是最关键的部分。

函数：`makeUserClaimsJWT()`

它会根据 `kind` 不同，生成不同权限。

### `sys` 权限

放到 `SYS` account。

主要是系统桥接类权限，比如：

- 发：`cephalon.im.npc.>`
- 发：`_INBOX.>`
- 收：`$SYS.ACCOUNT.>`
- 收：`client.status.report`

### `user` 权限

放到 `APP` account。

当前允许的核心 subject 有：

- 发：`cephalon.im.user.<user_id>`
- 发：`cephalon.im.npc.>`
- 发：`cephalon.square.>`
- 发：`cephalon.auth.whoami`
- 发：`$JS.API.>`
- 发：`$JS.ACK.>`
- 发：`_INBOX.>`

- 收：`cephalon.im.user.<user_id>`
- 收：`cephalon.im.npc.>`
- 收：`cephalon.square.>`
- 收：`_INBOX.>`
- 收：`cephalon.auth.whoami`
- 收：`$JS.API.>`

### `npc` 权限

也放到 `APP` account。

当前允许的核心 subject 有：

- 发：`cephalon.im.npc.<apiKey>.>`
- 发：`cephalon.im.npc.<apiKey>._discover`
- 发：`cephalon.im.user.>`
- 发：`client.status.report`
- 发：`cephalon.square.>`
- 发：`cephalon.auth.whoami`
- 发：`$JS.API.>`
- 发：`$JS.ACK.>`
- 发：`_INBOX.>`

- 收：`cephalon.im.npc.<apiKey>.>`
- 收：`cephalon.im.npc.<apiKey>._discover`
- 收：`_INBOX.>`
- 收：`cephalon.auth.whoami`
- 收：`$JS.API.>`

### 重要观察

不管是 `user` 还是 `npc`，**都没有任何 `$O.<bucket>.>` 权限**。

这就是后面媒体上传失败的直接原因。

## JWT 有两个有效期

这个服务里有两种“票”：

### 1. 给 NATS 的鉴权响应 JWT

`respondAuth()` 里生成的响应票据有效期是：

- `30 秒`

这张票是给 NATS 服务器看的，告诉它“这次连接准不准、权限卡是什么”。

### 2. 真正的用户权限 JWT

`makeUserClaimsJWT()` 里生成的用户权限 JWT 有效期是：

- `2 小时`

这张票才是真正的“连接权限卡”。

这意味着以后如果改权限逻辑，客户端通常需要：

- 断开重连
- 或等待新连接拿到新 JWT

## whoami 是做什么的

`whoami` 这条线跟连接鉴权是两回事。

它的作用更像“业务辅助查询”：

- 客户端发一个请求到 `cephalon.auth.whoami`
- 参数里可以带 `token`
- 或带 `apikey + device_id`
- 服务返回 `user_id`

它内部也会走一遍 `decideWhoami()` + `fakeValidate()`

所以：

- 连接鉴权用的是 `$SYS.REQ.USER.AUTH`
- 业务查询身份用的是 `cephalon.auth.whoami`

## 为什么你之前文本能通，媒体却失败

这是这次排查最重要的结论。

### 文本为什么能通

因为当前签发的 JWT 已经允许了：

- `cephalon.im.npc.>`
- `cephalon.im.user.>`
- `_INBOX.>`
- `$JS.API.>`

这些足够支撑：

- 客户端往 Lucy 的 `client` subject 发文本
- 客户端订阅 Lucy 的 `machine` subject
- 做普通 request-reply

### 媒体为什么失败

Lucy 的媒体不是走普通文本 subject，而是走 **JetStream Object Store**。

Object Store 底层会用一组 `$O.<bucket>...` 的 subject。

你当前实际报错是：

```text
Permissions Violation for Publish to "$O.lucy_media_v2.C..."
```

而当前 `auth-callout` 给 `user` / `npc` 签发的权限里，完全没有：

- `$O.lucy_media_v2.C.>`
- `$O.lucy_media_v2.M.>`
- 或更宽的 `$O.lucy_media_v2.>`

所以结果就是：

- 文本消息没问题
- 一到媒体上传就被 NATS 拒绝

## 日志说明了什么

这次只读看日志时，`auth-callout.service` 一直在打印类似：

```text
auth ok kind=user user_id=user_211b3f142e
```

这说明：

1. 你的 token 连接确实走到了 `auth-callout`
2. 它被识别成了 `kind=user`
3. 它被映射成了 `user_211b3f142e`
4. 连接鉴权本身是成功的

也就是说，问题不在“连不上”或“鉴权失败”，而在：

- 鉴权成功了
- 但签发出来的权限不包含媒体 bucket 所需的 subject

## 如果以后要改，真正要改哪里

这次只做调研，没有动远端。

但从结构上看，后面如果要支持 Lucy 媒体，真正要改的是：

- `/home/ubuntu/npc_im_server/auth-callout/main.go`

重点函数是：

- `decideIdentity()`：决定连接属于 `user` / `npc` / `sys`
- `makeUserClaimsJWT()`：真正给连接分配权限

### 如果你的目标是：

“所有 client 和 device 都能互相上传下载媒体文件”

那么最直接的思路会是：

- 在 `kind=user` 的权限里加入 `lucy_media_v2` 的 Object Store subject
- 在 `kind=npc` 的权限里也加入同样的 Object Store subject

因为你要的是“彼此互通”，不是“按用户严格隔离 bucket”。

### 这意味着什么

这会让 `APP` account 下拿到这类 JWT 的连接，都能访问这个共享 bucket。

优点：

- 最符合你现在的架构诉求
- 最直接
- 改动位置集中

代价：

- 这个 bucket 的媒体就不是强隔离的
- 任何拿到这组权限的 `user` / `npc`，理论上都能访问 bucket 里的对象

## 对小白的最终理解版本

你可以把整套系统想成这样：

1. 客户端先去敲 NATS 的门
2. NATS 不直接开门，而是问 `auth-callout`
3. `auth-callout` 看看你带的是 token，还是 apiKey + deviceId
4. 它把你归类成 `user` 或 `npc`
5. 它再给你发一张临时权限卡
6. 这张卡上写着“你能去哪些房间”
7. 现在这张卡写了“你能去发文本消息的房间”
8. 但没有写“你能去媒体仓库的房间”
9. 所以文本能发，媒体仓库进不去

## 本次只读调研结论

- `auth-callout` 工作正常
- 连接鉴权链路工作正常
- 你的 token 会被识别为 `kind=user`
- 当前服务签发的 JWT 权限不包含 Lucy 媒体 bucket 的 Object Store subject
- 所以当前的媒体失败是**权限设计问题**，不是 NATS 挂了，也不是 Lucy 文本链路挂了

## 后续建议

如果下一步要继续推进，最合理的顺序是：

1. 先确定你是不是要“共享 bucket，所有 client/device 都能互通”
2. 如果是，就在 `auth-callout/main.go` 的 `user` 和 `npc` 权限分支里一起补媒体 bucket 的 Object Store 权限
3. 编译 `auth-callout`
4. 重启 `auth-callout.service`
5. 让客户端重新连接
6. 再重跑 Lucy 的图片/音频端到端测试

这次文档只负责解释现状，不包含任何改动。
