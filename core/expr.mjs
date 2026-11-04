// 安全的小型表达式求值器（不用 eval）。
// 支持：数字、变量名、true/false、( )、! not、* / %、+ -、< <= > >= == !=、&& and、|| or
// 用于 @if / @set / 选项条件。

const TOK = /\s*(?:(\d+(?:\.\d+)?)|([a-z_][a-z0-9_]*)|(&&|\|\||==|!=|<=|>=|[-+*\/%<>!()]))/y;

export function tokenize(src) {
  const out = [];
  TOK.lastIndex = 0;
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    TOK.lastIndex = i;
    const m = TOK.exec(s);
    if (!m) throw new Error(`表达式无法解析：「${s}」位置 ${i}`);
    i = TOK.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) {
      const w = m[2];
      if (w === 'and') out.push({ t: 'op', v: '&&' });
      else if (w === 'or') out.push({ t: 'op', v: '||' });
      else if (w === 'not') out.push({ t: 'op', v: '!' });
      else if (w === 'true') out.push({ t: 'num', v: 1 });
      else if (w === 'false') out.push({ t: 'num', v: 0 });
      else out.push({ t: 'var', v: w });
    } else out.push({ t: 'op', v: m[3] });
  }
  return out;
}

// 编译成 AST（JSON 可序列化）
export function parseExpr(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error(`表达式不完整：「${src}」`);
    if (t.t === 'num') return { k: 'n', v: t.v };
    if (t.t === 'var') return { k: 'v', v: t.v };
    if (t.v === '(') { const e = or(); if (!isOp(')')) throw new Error(`缺少 ）：「${src}」`); p++; return e; }
    if (t.v === '!') return { k: 'u', op: '!', a: primary() };
    if (t.v === '-') return { k: 'u', op: '-', a: primary() };
    throw new Error(`表达式意外的符号 ${t.v}：「${src}」`);
  }
  const bin = (next, ops) => () => {
    let a = next();
    while (peek() && peek().t === 'op' && ops.includes(peek().v)) { const op = toks[p++].v; a = { k: 'b', op, a, b: next() }; }
    return a;
  };
  const mul = bin(primary, ['*', '/', '%']);
  const add = bin(mul, ['+', '-']);
  const cmp = bin(add, ['<', '<=', '>', '>=']);
  const eq = bin(cmp, ['==', '!=']);
  const and = bin(eq, ['&&']);
  const or = bin(and, ['||']);
  const ast = or();
  if (p !== toks.length) throw new Error(`表达式多余内容：「${src}」`);
  return ast;
}

export function exprVars(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.k === 'v') out.add(ast.v);
  if (ast.a) exprVars(ast.a, out);
  if (ast.b) exprVars(ast.b, out);
  return out;
}

export function evalExpr(ast, vars) {
  switch (ast.k) {
    case 'n': return ast.v;
    case 'v': return Number(vars[ast.v] ?? 0);
    case 'u': { const a = evalExpr(ast.a, vars); return ast.op === '!' ? (a ? 0 : 1) : -a; }
    case 'b': {
      if (ast.op === '&&') return evalExpr(ast.a, vars) ? evalExpr(ast.b, vars) : 0;
      if (ast.op === '||') { const a = evalExpr(ast.a, vars); return a ? a : evalExpr(ast.b, vars); }
      const a = evalExpr(ast.a, vars), b = evalExpr(ast.b, vars);
      switch (ast.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b; case '%': return b === 0 ? 0 : a % b;
        case '<': return +(a < b); case '<=': return +(a <= b); case '>': return +(a > b);
        case '>=': return +(a >= b); case '==': return +(a === b); case '!=': return +(a !== b);
      }
    }
  }
  throw new Error('bad ast');
}
