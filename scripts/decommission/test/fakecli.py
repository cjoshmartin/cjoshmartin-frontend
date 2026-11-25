"""Fake gcloud, gh, ssh (Dokku) and curl for testing scripts/decommission/*.sh.

Usage: python3 -I fakecli.py <gcloud|gh|ssh|curl> ARGS...

State lives under $FAKE_ROOT. Every call is appended to $FAKE_ROOT/calls.log, so tests can
assert which commands ran. Only the command shapes the decommission scripts use are
implemented; anything else exits 99 so a script change cannot pass silently.

Layout:
  gcs/<bucket>/meta.json              {"pap": "inherited"|"enforced", "ubla": true, "generation": n}
  gcs/<bucket>/iam.json               bucket IAM policy
  gcs/<bucket>/objects/<name>         object data (generation in <name>.gen)
  iam/<service account>.json          [{"name": ".../keys/<id>", "keyType": "USER_MANAGED"|"SYSTEM_MANAGED"}]
  gh/<owner>__<name>.json             {"visibility": "PRIVATE", "isArchived": false}
  gh/<owner>__<name>.git              bare repo backing that GitHub repo
  dokku/apps/<app>                    app exists when the file exists
  dokku/services/<svc>/image          e.g. postgres:16.1
  dokku/services/<svc>/links          linked apps, one per line
  dokku/services/<svc>/export.dump    what postgres:export prints
  site/<path>.html                    page bodies for https://cjoshmartin.com (index.html for /)
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.environ["FAKE_ROOT"]


def log(*parts):
    with open(os.path.join(ROOT, "calls.log"), "a") as f:
        f.write(" ".join(parts) + "\n")


def die(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def unsupported(tool, argv):
    die("fakecli: unsupported %s call: %r" % (tool, argv), 99)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=1)


def opt(argv, name):
    """Value of --name=value or --name value."""
    for i, a in enumerate(argv):
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
    return None


# ---------------------------------------------------------------- gcloud
def split_gs(url):
    assert url.startswith("gs://"), url
    rest = url[5:]
    bucket, _, name = rest.partition("/")
    return bucket, name


def bucket_dir(bucket):
    d = os.path.join(ROOT, "gcs", bucket)
    if not os.path.isdir(d):
        die("ERROR: (gcloud.storage) gs://%s not found: 404." % bucket)
    return d


def obj_md5(path):
    with open(path, "rb") as f:
        return base64.b64encode(hashlib.md5(f.read()).digest()).decode()


def list_objects(bucket, pattern):
    d = os.path.join(bucket_dir(bucket), "objects")
    prefix = pattern[:-2] if pattern.endswith("**") else pattern
    out = []
    for root, _, files in os.walk(d):
        for fn in files:
            if fn.endswith(".gen"):
                continue
            full = os.path.join(root, fn)
            name = os.path.relpath(full, d)
            if name.startswith(prefix):
                out.append({"name": name, "md5_hash": obj_md5(full), "size": os.path.getsize(full),
                            "generation": open(full + ".gen").read().strip()})
    return sorted(out, key=lambda o: o["name"])


def gcloud(argv):
    log("gcloud", *argv)
    if argv[:3] == ["config", "get-value", "account"]:
        print("owner@example.test")
        return
    if argv[:3] == ["storage", "buckets", "describe"]:
        bucket, _ = split_gs(argv[3])
        meta = read_json(os.path.join(bucket_dir(bucket), "meta.json"))
        fmt = opt(argv, "--format")
        if fmt == "value(public_access_prevention,uniform_bucket_level_access)":
            print("%s\t%s" % (meta["pap"], "True" if meta["ubla"] else "False"))
        elif fmt == "value(public_access_prevention)":
            print(meta["pap"])
        else:
            unsupported("gcloud", argv)
        return
    if argv[:3] == ["storage", "buckets", "get-iam-policy"]:
        bucket, _ = split_gs(argv[3])
        print(json.dumps(read_json(os.path.join(bucket_dir(bucket), "iam.json"))))
        return
    if argv[:3] == ["storage", "buckets", "remove-iam-policy-binding"]:
        bucket, _ = split_gs(argv[3])
        member, role = opt(argv, "--member"), opt(argv, "--role")
        if "--all" not in argv:
            unsupported("gcloud", argv)
        path = os.path.join(bucket_dir(bucket), "iam.json")
        policy = read_json(path)
        found = False
        for b in policy["bindings"]:
            if b["role"] == role and member in b["members"]:
                b["members"].remove(member)
                found = True
        policy["bindings"] = [b for b in policy["bindings"] if b["members"]]
        if not found:
            die("ERROR: Policy binding with the specified principal and role not found!")
        write_json(path, policy)
        return
    if argv[:3] == ["storage", "buckets", "update"] and "--public-access-prevention" in argv:
        bucket, _ = split_gs(argv[3])
        path = os.path.join(bucket_dir(bucket), "meta.json")
        meta = read_json(path)
        meta["pap"] = "enforced"
        write_json(path, meta)
        return
    if argv[:3] == ["storage", "objects", "list"]:
        bucket, pattern = split_gs(argv[3])
        objs = list_objects(bucket, pattern)
        fmt = opt(argv, "--format")
        if fmt == "json":
            print(json.dumps(objs))
        elif fmt == "value(name)":
            for o in objs:
                print(o["name"])
        else:
            unsupported("gcloud", argv)
        return
    if argv[:3] == ["storage", "objects", "describe"]:
        bucket, name = split_gs(argv[3])
        objs = [o for o in list_objects(bucket, name) if o["name"] == name]
        if not objs:
            die("ERROR: gs://%s/%s not found: 404." % (bucket, name))
        if opt(argv, "--format") != "value(md5_hash,size,generation)":
            unsupported("gcloud", argv)
        o = objs[0]
        print("%s\t%s\t%s" % (o["md5_hash"], o["size"], o["generation"]))
        return
    if argv[:2] == ["storage", "cp"]:
        if os.environ.get("CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED") != "False":
            die("fakecli: expected parallel composite uploads to be disabled", 98)
        args = [a for a in argv[2:] if not a.startswith("--")]
        src, dst = args
        bucket, name = split_gs(dst)
        d = bucket_dir(bucket)
        target = os.path.join(d, "objects", name)
        if opt(argv, "--if-generation-match") == "0" and os.path.exists(target):
            die("ERROR: HTTPError 412: At least one of the pre-conditions you specified did not hold.")
        if opt(argv, "--if-generation-match") != "0":
            die("fakecli: uploads must be create-only", 98)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(src, target)
        meta_path = os.path.join(d, "meta.json")
        meta = read_json(meta_path)
        meta["generation"] = meta.get("generation", 1000) + 1
        write_json(meta_path, meta)
        with open(target + ".gen", "w") as f:
            f.write(str(meta["generation"]))
        print("Copying file://%s to %s" % (src, dst), file=sys.stderr)
        return
    if argv[:3] == ["storage", "ls", "-l"]:
        bucket, pattern = split_gs(argv[3])
        objs = list_objects(bucket, pattern)
        for o in objs:
            print("%10d  2026-11-26T09:00:00Z  gs://%s/%s" % (o["size"], bucket, o["name"]))
        print("TOTAL: %d objects" % len(objs))
        return
    if argv[:4] == ["iam", "service-accounts", "keys", "list"]:
        sa = opt(argv, "--iam-account")
        keys = read_json(os.path.join(ROOT, "iam", sa + ".json"))
        if keys is None:
            die("ERROR: PERMISSION_DENIED: Permission 'iam.serviceAccountKeys.list' denied")
        if opt(argv, "--managed-by") == "user" and os.environ.get("FAKE_IGNORE_MANAGED_BY") != "1":
            keys = [k for k in keys if k["keyType"] == "USER_MANAGED"]
        fmt = opt(argv, "--format")
        if fmt == "json":
            print(json.dumps(keys))
        elif fmt == "value(name.basename())":
            for k in keys:
                print(k["name"].rsplit("/", 1)[-1])
        else:
            unsupported("gcloud", argv)
        return
    if argv[:4] == ["iam", "service-accounts", "keys", "delete"]:
        key_id, sa = argv[4], opt(argv, "--iam-account")
        path = os.path.join(ROOT, "iam", sa + ".json")
        keys = read_json(path)
        match = [k for k in keys if k["name"].endswith("/" + key_id)]
        if not match:
            die("ERROR: NOT_FOUND: key %s" % key_id)
        if match[0]["keyType"] != "USER_MANAGED":
            log("VIOLATION deleted a system-managed key", key_id)
        write_json(path, [k for k in keys if not k["name"].endswith("/" + key_id)])
        return
    unsupported("gcloud", argv)


# ---------------------------------------------------------------- gh
def repo_paths(repo):
    base = os.path.join(ROOT, "gh", repo.replace("/", "__"))
    return base + ".json", base + ".git"


def gh(argv):
    log("gh", *argv)
    if argv[:2] == ["auth", "status"]:
        return
    if argv[:2] == ["api", "user"]:
        print("tester")
        return
    if argv[0] == "api" and argv[1].startswith("user/memberships/orgs/"):
        print("admin")
        return
    if argv[:3] == ["config", "get", "git_protocol"]:
        print("https")
        return
    if argv[:2] == ["repo", "view"]:
        state_path, _ = repo_paths(argv[2])
        state = read_json(state_path)
        if state is None:
            die("GraphQL: Could not resolve to a Repository with the name '%s'. (repository)" % argv[2])
        jq = opt(argv, "--jq") or ""
        archived = "true" if state["isArchived"] else "false"
        if "archived=" in jq:
            print("%s archived=%s" % (state["visibility"], archived))
        else:
            print("%s %s" % (state["visibility"], archived))
        return
    if argv[:2] == ["repo", "create"]:
        state_path, git_path = repo_paths(argv[2])
        if os.path.exists(state_path):
            die("GraphQL: Name already exists on this account (createRepository)")
        if "--private" not in argv:
            die("fakecli: repo must be created private", 98)
        subprocess.run(["git", "init", "-q", "--bare", git_path], check=True)
        write_json(state_path, {"visibility": "PRIVATE", "isArchived": False})
        return
    if argv[:2] == ["repo", "archive"]:
        state_path, git_path = repo_paths(argv[2])
        state = read_json(state_path)
        state["isArchived"] = True
        write_json(state_path, state)
        # An archived repo rejects pushes.
        hook = os.path.join(git_path, "hooks", "pre-receive")
        with open(hook, "w") as f:
            f.write("#!/bin/sh\necho 'This repository was archived so it is read-only.' >&2\nexit 1\n")
        os.chmod(hook, 0o755)
        return
    if argv[:2] == ["repo", "clone"]:
        _, git_path = repo_paths(argv[2])
        extra = argv[argv.index("--") + 1:] if "--" in argv else []
        subprocess.run(["git", "clone", *extra, git_path, argv[3]], check=True)
        return
    unsupported("gh", argv)


# ---------------------------------------------------------------- ssh (Dokku)
def ssh(argv):
    if "--" not in argv:
        unsupported("ssh", argv)
    cmd = argv[argv.index("--") + 1:]
    log("ssh", *cmd)
    if cmd and cmd[0] == "--quiet":
        cmd = cmd[1:]
    d = os.path.join(ROOT, "dokku")
    apps = os.path.join(d, "apps")
    services = os.path.join(d, "services")

    def links(svc):
        p = os.path.join(services, svc, "links")
        return [l for l in open(p).read().split() if l] if os.path.exists(p) else []

    def set_links(svc, values):
        with open(os.path.join(services, svc, "links"), "w") as f:
            f.write("".join(v + "\n" for v in values))

    verb, args = cmd[0], cmd[1:]
    if verb == "apps:exists":
        sys.exit(0 if os.path.exists(os.path.join(apps, args[0])) else 1)
    if verb == "postgres:list":
        for s in sorted(os.listdir(services)):
            print(s)
        return
    if verb == "postgres:app-links":
        for s in sorted(os.listdir(services)):
            if args[0] in links(s):
                print(s)
        return
    if verb == "postgres:exists":
        sys.exit(0 if os.path.isdir(os.path.join(services, args[0])) else 1)
    if verb == "postgres:info" and args[1:] == ["--version"]:
        print(open(os.path.join(services, args[0], "image")).read().strip())
        return
    if verb == "postgres:links":
        for a in links(args[0]):
            print(a)
        return
    if verb == "postgres:export":
        with open(os.path.join(services, args[0], "export.dump"), "rb") as f:
            sys.stdout.buffer.write(f.read())
        return
    if verb == "storage:list":
        print("%s volume bind mounts:" % args[0])
        return
    if verb == "apps:destroy" and args[0] == "--force":
        os.remove(os.path.join(apps, args[1]))
        for s in os.listdir(services):
            set_links(s, [a for a in links(s) if a != args[1]])
        print("Destroying %s (including all add-ons)" % args[1])
        return
    if verb == "postgres:destroy" and args[1:] == ["--force"]:
        if links(args[0]):
            die(" !     Cannot delete linked service")
        shutil.rmtree(os.path.join(services, args[0]))
        return
    unsupported("ssh", argv)


# ---------------------------------------------------------------- curl
def curl(argv):
    log("curl", *argv)
    out_file, write_out, fail, url = None, None, False, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-o", "-w", "--max-time", "--resolve"):
            if a == "-o":
                out_file = argv[i + 1]
            elif a == "-w":
                write_out = argv[i + 1]
            i += 2
            continue
        if a.startswith("-") and not a.startswith("--"):
            fail = fail or "f" in a
        elif not a.startswith("-"):
            url = a
        i += 1
    body, code = b"", 404
    if url.startswith("https://cjoshmartin.com"):
        path = url[len("https://cjoshmartin.com"):].strip("/") or "index"
        page = os.path.join(ROOT, "site", path + ".html")
        if os.path.exists(page):
            body, code = open(page, "rb").read(), 200
    elif url.startswith("https://storage.googleapis.com/"):
        bucket = url.split("/")[3]
        meta = read_json(os.path.join(ROOT, "gcs", bucket, "meta.json"))
        policy = read_json(os.path.join(ROOT, "gcs", bucket, "iam.json"))
        public = any("allUsers" in b["members"] for b in policy["bindings"])
        code = 200 if public and meta["pap"] != "enforced" else 403
    else:
        unsupported("curl", argv)
    if code >= 400 and fail:
        sys.exit(22)
    if out_file:
        with open(out_file, "wb") as f:
            f.write(body)
    else:
        sys.stdout.buffer.write(body)
    if write_out:
        sys.stdout.write(write_out.replace("%{http_code}", str(code)))


TOOLS = {"gcloud": gcloud, "gh": gh, "ssh": ssh, "curl": curl}
if __name__ == "__main__":
    tool, argv = sys.argv[1], sys.argv[2:]
    # FAKE_READ_STDIN=1 makes every fake drain a non-terminal stdin, as a command that prompts
    # would. A script that loops over a here-document and lets a command inherit it then
    # loses the rest of its plan, which the tests detect. ssh -n never reads stdin.
    if os.environ.get("FAKE_READ_STDIN") == "1" and not (tool == "ssh" and "-n" in argv) and not sys.stdin.isatty():
        sys.stdin.read()
    TOOLS[tool](argv)
