What problem is Mu solving, and why was it hard?

The paper, “Microsecond Consensus for Microsecond Applications” (Mu), is about a very specific pain point: some modern systems now do useful work in only a few microseconds, but the “gold standard” way we make distributed services fault-tolerant, state machine replication (SMR), has historically added tens to hundreds of microseconds of overhead, and tens to hundreds of milliseconds to fail over after a leader crash. At microsecond scale, those “traditional” overheads are not overheads anymore, they are the whole budget.  ￼

The motivation is not abstract. The paper grounds it in domains where microseconds are either money, safety, or compounding latency in a large microservice graph: trading, embedded control, and microservices with stateful components such as key value stores.  ￼

Why is SMR expensive? SMR gives you linearizability, meaning the replicated service behaves as if there were one single copy of the state, and every operation “takes effect” at one instant between call and return. That is the strong consistency target that many critical systems want.  ￼  ￼
To get linearizability under crashes and asynchrony, classic leader based protocols in the Paxos family end up doing multiple coordinated steps (prepare, accept, acknowledgments), and they require followers to participate in the critical path.  ￼  ￼

Why is that hard to “just optimize”? Because the hardest part of consensus is not the normal case when everyone agrees on the leader. It is preventing split brain and races between concurrent leaders during failure suspicion, network jitter, or delayed scheduling. Traditional protocols handle that with extra message rounds and follower responses. Mu’s central claim is: if you want to get down to about a microsecond, you cannot merely shave cycles. You need a different lever.  ￼

That lever is RDMA, and, more specifically, treating RDMA’s access control as a first-class concurren ￼mote Direct Memory Access) lets one machine read or write another machine’s registered memory without involving the remote CPU in the data path, which is why it can be extremely low latency and low jitter when done carefully.  ￼  ￼
But RDMA is not “magic shared memory”. It has protection domains, **mem ￼d permissions, and queue pairs (QPs) that define what a remote peer is allowed to do.  ￼  ￼
Mu’s question becomes:

If a leader could replicate a request by doing only one round of one-sided RDMA writes into follower logs, c ￼aders change, without paying extra message rounds?

That “still correct” part is exactly where the paper spends its novelty budget.

⸻

The big idea: what Mu’s features buy you, and what that enables

Mu introduces two core ideas that work together.

First, in the common case, Mu’s leader replicates by directly writing the request into each follower’s log with one-sided RDMA write, and followers do no network communication at all on the fast path.  ￼
The paper argues that this reaches the practical lower bound of what current RDMA hardware can do for replication latency: essentially one “one-sided round”.  ￼

Second, to keep that fast path safe, Mu ￼a replica’s log” an explicit invariant: each replica grants RDMA write permission to its log to exactly one leader at a time, and no one else.  ￼
So the way Mu prevents two leaders from racing is not primarily “proposal numbers and follower replies” as in classic Paxos, but “a competing leader’s writes literally fail because it does not have permission.” That is the concep ￼2L443-L461

What does this enable application-wise? The paper actually implements Mu and integrates it with several real systems, including a financial exchange matching engine (Liquibook), Redis, Memcached, and the RDMA key value store HERD, ￼ only one of the compared systems with overhead that is plausibly acceptable for true microsecond applications.  ￼  ￼

This is the “why it matters” claim: microsecond services exist, and if replication adds several microseconds or failover takes milliseconds, replication becomes either a competitive disadvantage or ￼e ￼2L73-L82

⸻

Background you need, but only the parts that matter here

SMR as “log agreement + deterministic replay”

Mu adopts the standard SMR picture. Each replica keeps (1) a copy of the application and (2) a log of client re ￼hooses what request goes in each log slot. Replicas then apply log entries in order. If the application is deterministic, replicas stay identical.  ￼

Leader-based SMR is a performance optimization and a simplification: clients talk to one leader, the leader orders requests, and the leader can respond once the request is safely replicated on a majority.  ￼
“Majority” matters because, with crash faults, any two majorities intersect in at least one replica, which is what prevents two different values from both being “committed” for the same slot.

Paxos terminology matters mainly as  ￼nterprets it. Paxos uses increasing proposal numbers and a two-phase protocol (prepare then accept) to prevent conflicting leaders from choosing different values.  ￼  ￼

RDMA concepts you actually need to understand Mu

RDMA exposes one-sided operations like RDMA Write and RDMA Read, which can complete without the remote CPU actively running receive cod ￼49  ￼
Mu uses Reliable Connection (RC) transport, which provides reliable, in-order delivery between a connected pair of QPs.  ￼  ￼

Two objects matter in Mu:
	•	A Memory Region (MR) is registered user memory that the NIC is allowed to access ￼lags such as allowing remote reads or remote writes.  ￼  ￼
	•	A Queue Pair (QP) is the endpoint over which RDMA work requests are posted, and it also carries access fla ￼e through states like RESET, INIT, RTR, RTS.  ￼

Mu’s permission trick relies on the fact that you can structure RDMA such that a given remote peer is allowed to write only if its QP and/or the MR permissions allow it, and you can change those permissions dynamically. The paper notes multiple ways  ￼nge QP access flags, or force QPs through state changes.  ￼

That is enough RDMA background to follow the design. You do not need to be an RDMA performance engineer to understand the logic, but you do need to internalize that “permission” is enforced by NIC hardware and manifests as remote RDMA writes that succeed or fail.

⸻

How Mu works, as a story with both planes

Mu is easiest to understand if you keep the paper’s architectural split: the replication plane is obsessed with making the common case fast, and the background plane is obsessed with detecting trouble, electing leaders, and flipping permissions safely. They run on separate threads and even separate QPs/MRs for isolation.  ￼

Scene ￼ader

Imagine a system with 3 replicas (the paper evaluates 3-way replication as typical). One replica currently believes it is leader, and followers also believe that replica is leader, so everyone is aligned.  ￼

Each replica maintains a local log in memory. Crucially, each replica has granted RDMA write permission on its own log to the current leader and to nobody else.  ￼

A client request arrives at the leader. Mu assumes there is a small “capture and inject” shim to intercept requests before they reach the application and later inject them into followers. The request is trea ￼ileciteturn19file2L325-L335

Now the replication plane executes the fast path: the leader appends the request to the next log slot and replicates it by issuing RDMA Writes to followers’ logs. Once the leader knows the request is replicated on a **majo ￼on execute and respond. Followers do not send messages; they just watch their own local log memory.  ￼

Two subtle details make this ac ￼d offset (FUO).** Each replica’s log metadata includes an FUO, the lowest index it believes is undecided, plus per-slot tuples.  ￼
In steady state, FUO basically advances as slots become decided and applied. ￼ half-written entries.** RDMA Writes are not “transactional”. A follower could observe a partially written log entry if it reads while the leader is writing. Mu uses a standard trick: a canary byte at the end of each entry. The leader sets it non-zero when writing, and the follower checks the canary before trusting the entry.  ￼
The paper discusses an RDMA ordering caveat: in theory the canary could be visible before the rest, but in practice certain NIC and NUMA placement conditions give a left-to-right effect, and other RDMA systems make ￼note you could make the canary a checksum to be robust to ordering anomalies.  ￼

How do followers know an entry is committed? In Paxos, learners get an explicit “chosen” signal. Mu avoids extra communication via “commit piggybacking”: because the leader only moves forward once earlier slots are decided, followers can treat the highest contiguous non-empty prefix as committed except possibly the last entry ￼ serves as the commit signal for the previous.  ￼

So in the healthy common case, Mu is essentially: leader writes requests into follower logs, followers locally replay, everyone stays in sync, and no follower network chatter is on the critical path.

Scene 2: why concurrent leaders are the r ￼assume trouble: a leader might appear slow or dead. In classic SMR, this is where you risk two leaders both trying to make progress, or where you pay big timeouts to avoid false positives.

Mu’s replication algorithm is presented relative to Paxos, but with a major twist: followers are silent, and leaders “read and write” follower state directly through RDMA, treating follower memory as a published state.  ￼

The paper introduces a leader-maintained set called confirmedFollowers. A leader only performs consensus steps against replicas in this set, and membership has a meaning stronger than “they replied”. It means: those replicas have granted this leader write permission to their logs and revoked it from other leaders.  ￼

That is Mu’s core anti-race mechanism: if you are not the authorized writer for replica r’s log, your RDMA write into r’s log fails. If you are the authorized writer, then no other leader can be concurrently writing that log without first stealing permission, which Mu routes through the background plane.  ￼

In the “basic” form, Mu’s propose() resembles Paxos conceptually:
	•	Prepare-like step: read minProposal from confirmed followers, pick a higher proposal number, write it back, and read the slot at FUO.  ￼
	•	Accept-like step: write (proposal number, value) into the FUO slot on confirmed followers.  ￼

But the crucial safety condition is not “followers responded to me and promised”. It is: I only touch replicas whose permissions guarantee no other leader can write them while I operate.

Then Mu adds the key performance optimization that turns this into a microsecond system: once a leader observes only empty slots at som ￼lowers, it can omit the prepare phase for subsequent indices until it aborts, so the common-case cost of proposing becomes just the one-sided RDMA writes of the accept step to a majority.  ￼

So the replication plane stays fast by assuming leader stability and relying on permissions to make that as ￼ background plane, leader election and failure detection

Leader election in Mu is intentionally simple in policy and careful in mechanism.

Policy: each replica decides locally that the leader is the lowest-id replica it currently considers alive. There is no explicit voting protocol described here; the point is to make leader choice deterministic given a set of “alive” nodes.  ￼

Mechanism: “alive” is inferred via a pull-based heartbeat score. Each replica maintains a local heartbeat counter and increments ￼odically RDMA-read that counter. If the read observes progress since last time, the score goes up; otherwise it goes down. Scores are capped (0 to 15 in their tuning), and failure and recovery thresholds are different (2 and 6) to prevent oscillation.  ￼

The key subtlety is why this helps microsecond failover. In traditional push heartbeats, network jitter can delay heartbeat messages, so timeouts must be large to avoid false positives. In Mu’s pull-score design, network delays slow down th ￼he number of “same value” observations rather than causing a sudden silent gap. That lets you set aggressive thresholds without spurious leader changes under typical datacenter conditions.  ￼

The paper also acknowledges that huge network delay or connection breakage can still happen. Mu therefore has two layers: the small pull-score timeout for common failures, and the longer timeout  ￼vior for bigger disruptions.  ￼

A final systems detail here is “fate sharing”: because replication and leader election are separate threads, you could get a pathological case where the election thread is healthy but the replication thread is stuck, especially on the leader. That would block progress while preventing leader change. Mu addresses this by having election periodically check replication activity; if replication appear ￼de stops incrementing its heartbeat counter so that others will replace it.  ￼
This is a very practical example of the paper’s mindset: the correctness model is distributed algorithms, but microsecond behavior is often dominat ￼athologies.

Scene 4: leader change, permissions, and the “hard part” the paper discovered

When a leader is suspected failed, some replica will start behaving as the new leader by the local rule. But that does not automatically prevent the old leader from still being alive and writing. This is where Mu’s permission management becomes the safety gate.

Each replica has a permission request array in its background-plane memory region. A would-be leader writes into that array (one-sided RDMA write)  ￼lica that owns the log then revokes write access from the current holder and grants it to the requester, and sends an acknowledgment. If multiple would-be leaders request, the permission manager processes them one by one, ordered by requester id.  ￼

At a protocol level, this is what makes “confirmedFollowers” meaningful: your set is built only after replicas have executed this revoke/grant logic, so you know competing leaders cannot race you on those logs.

At a systems level, this is where the paper found a surprising bottleneck. Changing RDMA permissions is much slower than ordinary RDMA read/write operations, on the order of hundreds of microseconds, and this becomes a major contributor to failover time.  ￼

They evaluate three mechanisms:
	1.	Re-registering memory regions with different access flags, which becomes disastrously slow as region size grows.
	2.	Changing QP access flags, which is fa ￼ror state if operations are in flight.
	3.	Cycling QP states, slower but robust.

They choose a “fast-slow” path: try the fast QP access-flag change, and if it triggers errors, fall back to the robust QP state transition approach.  ￼
This is not just an implementation trick. It is part of the paper’s broader message: microsecond SMR hits hardware control-plane costs (permission changes) that traditional systems never cared about, so t ￼ 5: keeping the log finite, and keeping new leaders consistent

Mu uses a circular log with recycling. Each follower tracks a log-head pointer for the first entry not yet executed in the application. The leader reads followers’ heads and computes minHead, then it can safely reuse and zero out entries below that minimum, because all replicas have already applied them. Zeroing is necessary because the canary mechanism relies on empty entries being dis ￼le2L743-L761

Leader changes also need to handle stragglers and partially replicated work. The paper adds “catch up” phases:
	•	A new leader brings itself up to date by copying from the most advanced confirmed follower (highest FUO).  ￼
	•	Then it updates followers by copying missing log segments to them and aligning FUOs.  ￼

This is the part that makes Mu a complete SMR system rather than just a fast common-case trick. Without it, any replica that was not in the confirmed set would drift forever.

⸻

Experimental setup, results, and what the evaluation is really showing

The evaluation runs on a 4-node cluster with 100 Gbps Infi ￼, dual Xeon E5-2640 v4 CPUs, Ubuntu 18.04, and Mellanox OFED drivers.  ￼
They evaluate 3-way replication.  ￼

Replication latency

The headline is: **~1.3 m ￼e a small in-memory request, with ~1.6 microseconds at the 99th percentile.  ￼
Figure 3 shows that for small payloads up to the inline threshold (256 bytes in their setup), latency is roughly flat, because inlined RDMA avoids extra DMA to fetch payloads. Past 256B, latency rises gradually.  ￼

The paper is careful to show “standalone” (just Mu tight-looping) versus “attached” (integrated into apps). Attached adds cache and scheduling interference. They also compare two at ￼ead for app and replication) versus  ￼s a cache-coherence miss). They measure that miss as about 400 ns per request.  ￼
This is important because it tells you that at mic ￼ology becomes a first-order design choice.

Compared to prior systems they include, Mu is faster by multiples in median and has a much tighter tail. In their figures, they attribute competitor tail to involving CPUs ￼tical path and to serializing multiple RDMA events whose variances add up.  ￼
They explicitly mention systems like Hermes, DARE, and APUS as key baselines in this space.  ￼  ￼

End-to-end application latency

The more meaningful question is whether rep ￼relative to application work.

For their Liquibook setup, unreplicated median is about 4.08 microseconds, and replicated with Mu about 5.55 microseconds, which they frame as ~35% overhead.  ￼  ￼
For HERD, unreplicated about 2.25 microseconds, replicated with Mu about 3.59 microseconds.  ￼  ￼
The paper’s interpretation is that for true microsecond apps, even 1.3 microseconds is a big percentage, but  ￼u can be the only viable option.  ￼

For TCP-based Redis and Memcached, end-to-end latencies are around 115 microseconds unreplicated, so the extra ~1.5 microseconds is basically negligible.  ￼  ￼
This reinforces the paper’s positioning: Mu is not trying to win on classic millisecond-scale s ￼i ￼ to be dismissed as unavoidable.

Failover time

Mu reports 873 microseconds median fai ￼t ￼mbining fast failure detection and permission switching.  ￼
Their failover experiment injects failure by delaying the leader so it becomes tempor ￼he pull-score suspicion at followers.  ￼
They also explicitly separate “detection time” from “permission switch time” in t ￼i ￼cost center in their system.  ￼

⸻

Achievements and limitations

Here it is hard to avoid a small list, because the paper itself makes a few crisp points.

What Mu achieves, concretely:
	•	Replication overhead near the one-sided RDMA lower bound in the common case, by omitting prepare after the log is “clean” and by keeping followers silent on ￼file2L602-L608
	•	Strong consistency (they target linearizability) with leader changes handled via RDMA-enforced single-writer permissions and explicit leade ￼.  ￼  ￼
	•	Sub-millisecond failover by replacing push-heartbeat timeouts with pull-score reads and aggressively tuned thres ￼on switching.  ￼  ￼

Limitations the paper is explicit about:
	•	It relies on RDMA, so it targets datacenter or LAN environments with RDMA fabric, not WAN deployments.  ￼
	•	It is in-memory replication, not durable logging to stable storage. The a ￼pport for persistent memory flush as a possible direction.  ￼
	•	Permission switching is hundreds of microseconds on their NICs. They do engineering  ￼  ￼citeturn19file2L131-L140  ￼

⸻

Discussion: what to like, what to be skeptical about, and where the state of the art is now

￼M ￼reating RDMA as a faster message transport, it treats RDMA’s access control as a distributed systems primitive. That lines up with earlier ideas in  ￼Mu pushes it all the way into a complete SMR design with leader change, log recycling, and real application integrations.  ￼  ￼

The pull-score mechanism is also worth liking because it directly confronts a practical truth: microsecond failover is often dominated by jitte ￼  ￼a memory counter over RDMA changes how delay manifests, which lets you lower timeouts without triggering constant false elections.  ￼  ￼
It is not a “new consensus theorem”, it is a systems-level move that targets the right bottleneck for this regime.

What should you be skeptical about? Two things.

First, some safety-critical details sit on “engineering assumptions” that are common in RDMA systems but still ￼ left-to-right visibility in certain NIC/NUMA configurations for the canary scheme, or otherwise needing a checksum retry loop. Mu acknowledges this and sketches the robust alternative, but it matters if you imagine portability across NIC generations or different memory placement.  ￼

Second, Mu’s approach shifts work from the network data plane to the NIC and RDMA control plane, which is why permission ￼  ￼reality check: the microsecond fast path is possible, but the slow path may still be bounded by what NIC firmware and driver stacks optimize for today.  ￼

Is Mu “the end of the story” for state of the art? It is a cornerstone, but not the last word.

After Mu, there is continued work on RDMA-based atomic broadcast and replication protocols that optimize waiting and quorum behavior, such as Acuerdo (ICPP 2022).  ￼
In parallel, there is a strong trend toward in-network or SmartNIC / switch-assisted replication, which tries to cut  ￼ moving pieces of the protocol into programmable network devices. NetLR (VLDB 2022) explicitly positions itself against RDMA-based replication and against in-switch baselines like Harmonia, representing this line of evolution.  ￼
There is also work focusing on deployability and performance tradeoffs in consensus for d ￼(for example, Nezha in VLDB 2023 cites Mu among related systems).  ￼
And on the durability axis, OSDI 2023 work on replicating persistent-memory key value stores with RDMA shows that the “in-memory only” constraint is actively being tackled by the community, sometimes building on protocols like Hermes.  ￼

So, the most accurate way to place Mu today is: it demonstrates that near-microsecond SMR is feasible when you (1) exploit one-sided RDMA for the fast path and (2) use RDMA permissions as the core split-brain prevention mechanism, but it also exposes the next bottlenecks, namely permission-switch control-plane costs and the complexities of durability and broader deployment models.
