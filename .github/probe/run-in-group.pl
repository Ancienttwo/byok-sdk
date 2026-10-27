#!/usr/bin/perl
# Probe only (train/probe-macos-hang). Puts the command in a new process group
# and leaves a sentinel in that group that logs the sender of every SIGHUP,
# SIGCONT, SIGTERM and SIGINT the group receives, with a ps snapshot.
use strict;
use warnings;
use POSIX qw(setpgid getppid strftime);
use Time::HiRes qw(time sleep);

my $log = $ENV{PROBE_SENTINEL_LOG} or die "PROBE_SENTINEL_LOG unset\n";
setpgid(0, 0) or die "setpgid: $!\n";
my $group = getpgrp();

sub stamp { my $t = time; strftime('%H:%M:%S', gmtime $t) . sprintf('.%03d', ($t - int $t) * 1000) }
sub note {
  open my $fh, '>>', $log or return;
  print $fh stamp(), ' ', @_, "\n";
  close $fh;
}

my $pid = fork() // die "fork: $!\n";
if ($pid == 0) {
  my $parent = getppid();
  note("sentinel pid=$$ pgid=", getpgrp(), " parent=$parent group=$group");
  for my $name (qw(HUP CONT TERM INT)) {
    my $action = POSIX::SigAction->new(sub {
      my ($sig, $info) = @_;
      note("SIG$sig si_pid=$info->{pid} si_uid=$info->{uid} si_code=$info->{code}");
      system("ps -axo pid,pgid,ppid,tpgid,stat,etime,command | cut -c1-300 >> '$log'");
    }, POSIX::SigSet->new, POSIX::SA_SIGINFO());
    POSIX::sigaction(POSIX->can("SIG$name")->(), $action) or die "sigaction $name: $!\n";
  }
  my $deadline = time + 900;
  sleep 1 while getppid() == $parent && time < $deadline;
  note("sentinel: parent $parent gone (ppid now ", getppid(), ")");
  sleep 3;
  exit 0;
}
exec @ARGV or die "exec: $!\n";
