# PROJECT_MAP — inventário vivo do repositório

Gera um `PROJECT_MAP.md` listando o que já existe no repo (páginas, componentes,
hooks, services, etc.) com seus exports. É o que sustenta o **read-before-write**
dos agents e o **planning pass** do Orquestrador — sem isso, os agents recriam
coisas que já existem (o erro clássico do Multica).

## Uso

```bash
bun generate-project-map.ts [rootDir] [--out PROJECT_MAP.md]
# default rootDir = "src"
```

Exemplo:

```bash
bun generate-project-map.ts src --out PROJECT_MAP.md
```

## Onde rodar

Rode **dentro do repositório alvo** (o repo que os agents desenvolvem), não neste
projeto. Duas formas de manter atualizado:

- **CI (recomendado):** um step que roda o gerador a cada merge na `main` e
  commita o `PROJECT_MAP.md`. Assim ele nunca fica velho.
- **No início de cada execução do worker:** o worker roda o gerador logo após o
  clone, garantindo um mapa fresco antes de implementar.

## Limitações (de propósito, p/ manter simples)

- Extração de exports por regex (não AST). Pega `function/const/class/type/
  interface/export {}` e `export default`. Casos exóticos podem escapar.
- Categorização por convenção de pasta/sufixo. Se seu projeto usa outra estrutura,
  ajuste `categorize()`.
- Para footprint mais preciso, o Orquestrador complementa lendo o repo direto — o
  PROJECT_MAP é o ponto de partida, não a única fonte.
