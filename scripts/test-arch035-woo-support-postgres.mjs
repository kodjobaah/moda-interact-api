import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
const suffix=randomUUID().replaceAll("-","");
const container=`moda-api-arch035-support-${suffix}`;
const database=`support_${suffix.slice(0,16)}`;
const user=`support_${suffix.slice(16,28)}`;
const password=randomUUID();
let started=false,phase="starting disposable PostgreSQL";
const run=(bin,args,opts={})=>execFileSync(bin,args,{encoding:"utf8",stdio:"pipe",...opts});
const docker=args=>run("docker",args);
try{
  docker(["run","--detach","--rm","--name",container,"--env",`POSTGRES_DB=${database}`,
    "--env",`POSTGRES_USER=${user}`,"--env",`POSTGRES_PASSWORD=${password}`,
    "--publish","127.0.0.1::5432","pgvector/pgvector:pg17"]);
  started=true;phase="resolving PostgreSQL port";
  const port=docker(["port",container,"5432/tcp"]).trim().match(/:(\d+)$/)?.[1];
  if(!port)throw new Error("port unavailable");
  phase="waiting for PostgreSQL";let ready=false;
  for(let i=0;i<60;i++){
    try{docker(["exec",container,"psql","-U",user,"-d",database,"-v","ON_ERROR_STOP=1","-c","SELECT 1"]);ready=true;break;}
    catch{await delay(500);}
  }
  if(!ready)throw new Error("not ready");
  docker(["exec",container,"psql","-U",user,"-d",database,"-v","ON_ERROR_STOP=1","-c","CREATE EXTENSION IF NOT EXISTS vector"]);
  const env={...process.env,DATABASE_URL:`postgresql://${user}:${password}@127.0.0.1:${port}/${database}`};
  env.WOO_INSTALLATION_TEST_DATABASE_URL=env.DATABASE_URL;
  phase="generating Prisma Client";
  run("npx",["--no-install","prisma","generate","--schema","database/prisma/schema.prisma"],{env,stdio:"inherit"});
  phase="deploying migrations";
  run("npx",["--no-install","prisma","migrate","deploy","--schema","database/prisma/schema.prisma"],{env,stdio:"inherit"});
  phase="running Support integration";
  run("node",["--import","tsx","--test","--test-concurrency=1",
    "tests/integration/merchant/support/service.postgres.test.ts"],{env,stdio:"inherit"});
}catch{
  // Never print thrown errors or Docker arguments containing disposable secrets.
  process.stderr.write(`ARCH-035 Support PostgreSQL validation failed while ${phase}.\n`);
  process.exitCode=1;
}finally{
  if(started)try{docker(["rm","--force",container]);}
  catch{process.stderr.write("Support PostgreSQL container cleanup failed.\n");process.exitCode=1;}
}
