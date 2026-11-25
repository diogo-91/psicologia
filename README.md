# Psicologia aplicada — versão para VPS (Coolify)

Um servidor Node sem dependências externas entrega o site e guarda tudo num banco SQLite
(`node:sqlite`, embutido no Node 22.13+). Login por senha única, definida numa variável de ambiente.

## Estrutura
```
server.js        servidor: arquivos estáticos (com Range para o áudio) + API + SQLite
public/          o site (index.html, app.js, dados.json, audio/)
Dockerfile       imagem node:22-alpine, roda como usuário sem privilégios
package.json     só metadados; não há npm install
```

## Variáveis de ambiente
| Variável | Obrigatória | Para quê |
|---|---|---|
| `SENHA`   | sim | senha de acesso ao site (mínimo 8 caracteres) |
| `SEGREDO` | sim | chave que assina o cookie de sessão (mínimo 32 caracteres; gere com `openssl rand -hex 32`) |
| `DB_PATH` | não | caminho do banco; padrão `/app/data/estudo.db` |
| `PORT`    | não | padrão `3000` |

Trocar o `SEGREDO` desconecta todos os aparelhos. Trocar a `SENHA` não desconecta quem já entrou.

## Publicar no Coolify
1. Suba esta pasta para um repositório no GitHub.
2. No Coolify: **+ New > Application**, escolha o repositório e o Build Pack **Dockerfile**.
3. **Port:** `3000`.
4. **Environment Variables:** `SENHA` e `SEGREDO`.
5. **Persistent Storage:** adicione um **volume** com destino `/app/data`. Sem isso, o banco é apagado a cada deploy.
   Use volume, não "directory mount": a imagem roda como usuário `node`, e uma pasta do host criada pelo root
   não deixaria o app gravar.
6. **Domains:** coloque o domínio (ex.: `https://estudo.seudominio.com.br`) e faça o deploy.
   O cookie de sessão exige HTTPS, que o Coolify gera sozinho.
7. Confira em `https://seu-dominio/saude` (deve responder `{"ok":true}`) e entre com a senha.

## Áudios
Salve o MP3 como `public/audio/modulo-2.mp3`, `public/audio/modulo-3.mp3` etc., faça commit e o Coolify
publica de novo (com auto deploy ligado).

## Backup
Tudo fica no arquivo `estudo.db` dentro do volume. Para copiar com o app rodando, na VPS:
```
docker exec <container> node -e "new (require('node:sqlite').DatabaseSync)('/app/data/estudo.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker cp <container>:/app/data/backup.db ./estudo-backup.db
```

## Rodar local
```
SENHA=minhasenha123 SEGREDO=$(openssl rand -hex 32) DB_PATH=./data/estudo.db npm start
```
Abra http://localhost:3000.
