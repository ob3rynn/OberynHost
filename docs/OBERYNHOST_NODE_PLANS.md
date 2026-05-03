# OberynHost Locked Node Plans

Generated: 2026-05-03  
Status: planning source of truth for locked node-capacity designs

This document combines the locked OberynHost node plans, excluding the CI/test-production Codex plan.

## Scope

This document is for infrastructure and product-planning decisions around sellable Minecraft hosting capacity.

It is not:

- a CI implementation plan,
- a live deployment runbook,
- a Stripe configuration source,
- a customer-facing pricing page,
- or a replacement for the phase-1 operator runbook.

Current launch/runtime truth still lives in the repo's operational docs and code. This file records the locked node-design decisions so old local planning files do not keep drifting into active context.

## Global rules

These rules apply across all plans unless a specific plan says otherwise:

- Do not overcommit RAM.
- Treat panel/server memory numbers conservatively as MiB for sizing.
- Do not market shared-thread capacity as dedicated CPU.
- Do not claim dedicated cores unless cgroup limits, product copy, and support policy are later built around that exact guarantee.
- Do not mix workload classes on specialized nodes.
- Recheck provider pricing, RAM-upgrade cost, protection cost, payment fees, and market prices before purchasing a node.
- Gross revenue is not profit. It excludes payment processing, taxes, backups, protection, monitoring, reserves, labor, and owner compensation.

## Summary table

| Plan | Stage | Product | Price | Capacity | Hardware target | Workload | RAM policy |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| Local foundation node | First/local launch | 2GB Paper Minecraft Server | $11.97/mo | 25 | Ryzen 9 5900X local host, Proxmox VM | Paper only | 2424 MiB container / 2024 MiB JVM |
| Cloud Paper node | First repeatable cloud Paper node | 4GB Paper Cloud Server | $14.97/mo | 96 | Hetzner AX162-R, 512GB RAM | Paper only | 4496 MiB container / 4096 MiB JVM |
| Fabric performance node | Future-stage | 6GB Fabric Performance Server | $24.97/mo | 64 | Hetzner AX162-R, 512GB RAM | Fabric only | 6544 MiB container / 6144 MiB JVM |
| Forge premium node | Future-stage | 8GB Forge Premium Server | $34.97/mo | 36 | Hetzner AX162-R, 512GB RAM | Forge only | 8592 MiB container / 8192 MiB JVM |

---

# 1. Local foundation node

## Status

Locked local foundation-node design.

This node exists to launch the first sellable budget Paper capacity, validate demand, generate early revenue on owned hardware, and prove the operating model before larger infrastructure spend.

This is not a premium node, Forge node, Fabric node, or long-term horizontal-scaling architecture. It is a high-density local foundation node.

## Product truth

Customer-facing product:

- `2GB Paper Minecraft Server`

Internal identifiers:

- plan code: `paper-2gb`
- product code: `minecraft-paper-2gb`
- Stripe env var: `STRIPE_PRICE_PAPER_2GB`

Pricing and capacity:

- monthly price: `$11.97/month`
- sellable capacity: `25 servers`
- runtime: Paper only
- container memory target: `2424 MiB` per server
- JVM memory target: `2024 MiB` per server

## Hardware

Host machine:

- CPU: Ryzen 9 5900X
- physical cores: 12
- total threads: 24
- total system RAM: 64 GiB
- virtualization: Proxmox VE
- storage model: ZFS
- primary workload boundary: one game-hosting VM

VM target:

- 20 CPU threads allocated to the game-hosting VM
- roughly 10 physical cores worth of compute exposed to the node workload
- 61 GiB RAM allocated to the game-hosting VM
- about 3 GiB RAM left to Proxmox/ZFS/networking/host overhead

## Density

Locked sellable server count:

- 25 servers

CPU density:

- 25 servers / roughly 10 physical cores
- 2.5 servers per physical-core equivalent

Interpretation:

- aggressive,
- intentional,
- acceptable only for budget Paper workloads,
- not acceptable for premium, modded, or performance-sensitive workloads.

Hard rule:

- Do not exceed 25 sellable servers on this local node.

## RAM model

Per server:

- 2424 MiB container allocation
- 2024 MiB JVM target
- 400 MiB approximate non-heap/container margin

Full allocation:

```text
25 servers x 2424 MiB = 60,600 MiB
60,600 MiB / 1024 = 59.18 GiB
```

System headroom against 64 GiB:

```text
65,536 MiB - 60,600 MiB = 4,936 MiB
4,936 MiB / 1024 = 4.82 GiB
```

Interpretation:

- RAM is tight.
- The tightness is intentional.
- This plan depends on strict memory discipline.
- Do not add extra sellable game-server capacity to this node.

## Operating boundaries

Allowed:

- small to moderate Paper servers,
- budget-tier customer expectations,
- mixed online populations,
- some idle or lightly loaded servers at any given time.

Not allowed:

- Forge,
- Fabric premium workloads,
- large public servers,
- heavy modpacks,
- premium low-contention claims,
- dedicated-core expectations.

If storefront, Pelican panel, routing, Wings, or other support services are colocated on the same physical box, they must be explicitly budgeted. The 25-server RAM allocation is not a shared cushion.

## Revenue

At full capacity:

```text
25 x $11.97 = $299.25/month gross
```

This is gross revenue before any taxes, payment fees, reserves, backups, protection, or owner compensation.

---

# 2. Cloud Paper node

## Status

Locked first repeatable cloud Paper node design.

This plan follows the local launch node and intentionally keeps the product simple:

- one Paper-only product,
- one RAM size,
- one price,
- no upgrade ladder,
- no upgrade pool,
- no mixed workloads,
- no RAM overcommit.

This is not a Forge node, Fabric node, premium dedicated-CPU node, or generic mixed-modpack Minecraft node.

## Product truth

Customer-facing product:

- `4GB Paper Cloud Server`

Pricing and capacity:

- monthly price: `$14.97/month`
- sellable capacity: `96 servers`
- marketed RAM: `4 GB`
- JVM target: `4096 MiB`
- container allocation: `4496 MiB`
- runtime: Paper only

Upgrade policy:

- no 2GB starter tier,
- no 6GB tier,
- no 8GB tier,
- no RAM upgrade pool,
- no oversold upgrade inventory.

## Hardware target

Provider:

- Hetzner

Server model:

- AX162-R

Target configuration:

- CPU: AMD EPYC 9454P
- physical cores: 48
- threads: 96
- RAM: 512GB target configuration
- storage: NVMe datacenter SSD storage per configured AX162-R order
- region: Europe
- protection: NeoProtect Company Plan or equivalent if required

Cost warning:

- Do not reuse old `$440/month` estimates as final truth unless a real configured Hetzner quote confirms them.
- Public provider pricing and RAM-upgrade pricing can move.
- Confirm final monthly cost in Hetzner Robot/configurator before purchase.

## Density

Target density:

```text
48 physical cores x 2 servers/core = 96 sellable servers
```

Interpretation:

- density is based on physical cores, not threads,
- hardware threads provide scheduling room,
- threads are not marketed as 96 sellable cores,
- this is not a dedicated-vCPU product.

## RAM model

Per server:

```text
4096 MiB JVM target
+ 400 MiB overhead allowance
= 4496 MiB total allocation
```

Full allocation:

```text
96 servers x 4496 MiB = 431,616 MiB
431,616 MiB / 1024 = 421.5 GiB
```

Headroom against 512 GiB:

```text
512 GiB - 421.5 GiB = 90.5 GiB headroom
```

Interpretation:

- 512GB RAM target is sufficient for this fixed 4GB-only plan.
- The plan does not depend on upgrade adoption.
- The plan does not need 768GB/960GB high-RAM economics.

## Positioning

Business positioning:

- controlled-performance Paper hosting,
- cleaner than bargain-bin shared hosting,
- simpler than premium/dedicated-core hosting,
- sold on clarity, capped density, and no RAM overcommit.

Do not market as:

- dedicated CPU,
- unlimited CPU,
- modpack hosting,
- Forge hosting,
- Fabric performance hosting.

## Revenue

At full capacity:

```text
96 x $14.97 = $1,437.12/month gross
```

This is gross revenue before fixed infrastructure cost, protection, payment fees, taxes, reserves, backups, monitoring, and owner compensation.

---

# 3. Fabric performance node

## Status

Locked future-stage Fabric performance node design.

This plan replaces the informal `monster node` concept. Do not use `monster node` as the final product or operating name.

This node should not launch before the 4GB Paper cloud node proves demand and the support model is stable.

## Product truth

Customer-facing product:

- `6GB Fabric Performance Server`

Pricing and capacity:

- monthly price: `$24.97/month`
- sellable capacity: `64 servers`
- marketed RAM: `6 GB`
- JVM target: `6144 MiB`
- container allocation: `6544 MiB`
- runtime: Fabric only

Upgrade policy:

- no RAM upgrades,
- no Paper,
- no Forge,
- no mixed workload class.

## Hardware target

Provider:

- Hetzner

Server model:

- AX162-R

Target configuration:

- CPU: AMD EPYC 9454P
- physical cores: 48
- threads: 96
- RAM: 512GB target configuration
- storage: NVMe datacenter SSD storage per configured AX162-R order
- protection: NeoProtect Company Plan or equivalent if required

Cost warning:

- The older approximate node-cost assumptions must not be treated as final.
- Obtain a live configured quote before purchasing.

## Density

Target capacity:

```text
64 sellable servers
```

CPU density:

```text
64 servers / 48 physical cores = 1.33 servers per physical core
```

Interpretation:

- lower-density shared hosting,
- stronger CPU-breathing-room story than generic RAM-tier hosting,
- still not a dedicated-core product.

## RAM model

Per server:

```text
6144 MiB JVM target
+ 400 MiB overhead allowance
= 6544 MiB total allocation
```

Full allocation:

```text
64 servers x 6544 MiB = 418,816 MiB
418,816 MiB / 1024 = 409.0 GiB
```

Headroom against 512 GiB:

```text
512 GiB - 409.0 GiB = 103.0 GiB headroom
```

Interpretation:

- RAM posture is healthy.
- This is a cleaner plan than any 8GB-upgrade/shared-pool model.
- The 512GB target works because the plan is fixed at 6GB and 64 servers.

## Positioning

This is not generic 6GB Minecraft hosting.

It is:

- Fabric-only,
- lower-density,
- no RAM overcommit,
- for customers who need more CPU breathing room than bargain RAM-per-dollar hosting.

Allowed product language:

> 6GB Fabric Performance is our lower-density Fabric-only hosting tier. It is built for heavier Fabric servers that need more CPU breathing room than bargain RAM-per-dollar hosting. We cap this node at 64 servers on a 48-core EPYC host and do not overcommit RAM.

Avoid:

- dedicated CPU,
- guaranteed cores,
- unlimited CPU,
- better than named competitors,
- zero-lag claims.

## Launch gate

Do not launch before:

- the 4GB Paper cloud node proves demand,
- support load is understood,
- operator procedures are stable,
- provider quote is confirmed,
- the Fabric-specific support boundary is written,
- the product page can explain the Fabric-only positioning without hype.

## Revenue

At full capacity:

```text
64 x $24.97 = $1,598.08/month gross
```

This is gross revenue before infrastructure, protection, fees, tax, reserves, backups, monitoring, and owner compensation.

---

# 4. Forge premium node

## Status

Locked future-stage Forge premium node design.

This plan replaces the older Forge premium upgrade model.

The final decision is a single fixed 8GB Forge product, not an 8GB/10GB/12GB upgrade ladder.

## Product truth

Customer-facing product:

- `8GB Forge Premium Server`

Pricing and capacity:

- monthly price: `$34.97/month`
- sellable capacity: `36 servers`
- marketed RAM: `8 GB`
- JVM target: `8192 MiB`
- container allocation: `8592 MiB`
- runtime: Forge only

Upgrade policy:

- no 10GB upgrade,
- no 12GB upgrade,
- no RAM upgrade ladder,
- no Paper workloads,
- no Fabric workloads,
- no RAM overcommit.

## Hardware target

Provider:

- Hetzner

Server model:

- AX162-R

Target configuration:

- CPU: AMD EPYC 9454P
- physical cores: 48
- threads: 96
- RAM: 512GB target configuration
- storage: 2 x 1.92TB NVMe SSD Datacenter Edition Gen4, software RAID 1 unless a later production runbook intentionally changes it
- network: 1Gbit guaranteed bandwidth baseline
- protection: external DDoS/protection service may be used if required

Cost warning:

- The old source's approximate fixed-cost assumption must not be treated as final.
- Obtain a live configured Hetzner quote and include protection/backups before launching this node.

## Density

Target capacity:

```text
36 sellable servers
```

CPU density:

```text
36 servers / 48 physical cores = 0.75 servers per physical core
1 server per 1.33 physical cores
```

Interpretation:

- very low-density shared hosting,
- strong CPU-breathing-room story,
- still not a dedicated-core product.

## RAM model

Per server:

```text
8192 MiB JVM target
+ 400 MiB overhead allowance
= 8592 MiB total allocation
```

Full allocation:

```text
36 servers x 8592 MiB = 309,312 MiB
309,312 MiB / 1024 = 302.06 GiB
```

Headroom against 512 GiB:

```text
512 GiB - 302.06 GiB = 209.94 GiB headroom
```

Interpretation:

- RAM posture is intentionally conservative.
- The node has substantial headroom for OS, Wings, Docker/container overhead, filesystem cache, logs, monitoring, and operational slop.
- The removed 12GB max-upgrade model technically fit, but compressed headroom and weakened the premium posture.

## Positioning

This is not a generic 8GB RAM bucket.

It is:

- Forge-only,
- lower-density,
- RAM-honest,
- CPU-breathing-room focused,
- intended for customers whose modpacks need more stability than bargain shared hosting.

Allowed product language:

> 8GB Forge Premium is our lower-density Forge-only hosting tier. It is built for heavier modded servers that need more CPU breathing room than bargain RAM-per-dollar hosting. We cap this node at 36 servers on a 48-core EPYC host and do not overcommit RAM.

Allowed claims:

- Forge-only,
- lower-density node,
- 36-server cap on a 48-core host,
- no RAM overcommit,
- 8192 MiB JVM target,
- 8592 MiB container allocation,
- built for heavier modded workloads,
- more CPU breathing room than bargain RAM-per-dollar hosting.

Do not claim:

- dedicated CPU,
- guaranteed cores,
- unlimited CPU,
- best performance,
- better than named competitors,
- zero lag,
- all modpacks guaranteed to run perfectly.

## Launch gate

Do not launch before:

- Paper cloud demand is proven,
- support capacity is understood,
- Forge support boundaries are written,
- a live provider quote confirms tolerable fixed cost,
- the product page can explain the premium positioning cleanly.

If total fixed monthly cost is high enough that the node cannot produce a tolerable margin at `$34.97 x 36`, do not launch it yet.

## Revenue

At full capacity:

```text
36 x $34.97 = $1,258.92/month gross
```

This is gross revenue before infrastructure, protection, fees, tax, reserves, backups, monitoring, and owner compensation.

---

# Rejected / superseded concepts

The following concepts should not be revived as active product plans without a new explicit decision:

- 108-server 3.5GB max-profit Paper node.
- Paper cloud RAM-upgrade ladders.
- Paper 2GB cloud entry tier with 4GB upgrade.
- Paper 6GB or 8GB upgrade tiers on the first AX162-R Paper node.
- Fabric `monster node` naming.
- Forge 8GB/10GB/12GB upgrade ladder.

Replacement decisions:

- First repeatable cloud Paper node is fixed `4GB Paper Cloud Server` at `$14.97/month`, 96 servers, no upgrades.
- Fabric future node is fixed `6GB Fabric Performance Server` at `$24.97/month`, 64 servers, no upgrades.
- Forge future node is fixed `8GB Forge Premium Server` at `$34.97/month`, 36 servers, no upgrades.
