import React from 'react';

export default function DeskLoadingSkeleton() {
  return (
    <div className="space-y-8 animate-pulse max-w-7xl mx-auto px-4 sm:px-6 py-6">
      {/* Welcome Skeleton */}
      <div className="bah-panel p-6 rounded-[20px] h-36 flex flex-col justify-between">
        <div className="space-y-2">
          <div className="h-6 w-1/3 bg-bah-panel-soft rounded" />
          <div className="h-4 w-1/2 bg-bah-panel-soft rounded" />
        </div>
        <div className="flex gap-3">
          <div className="h-9 w-32 bg-bah-panel-soft rounded" />
          <div className="h-9 w-28 bg-bah-panel-soft rounded" />
        </div>
      </div>

      {/* Today Read Skeleton */}
      <div className="bah-panel p-6 rounded-[20px] h-60 space-y-4">
        <div className="flex justify-between items-center">
          <div className="h-4 w-40 bg-bah-panel-soft rounded" />
          <div className="h-4 w-28 bg-bah-panel-soft rounded" />
        </div>
        <div className="h-7 w-3/4 bg-bah-panel-soft rounded" />
        <div className="grid grid-cols-2 gap-4 pt-2">
          <div className="h-24 bg-bah-panel-soft rounded" />
          <div className="h-24 bg-bah-panel-soft rounded" />
        </div>
      </div>

      {/* Targets Skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bah-panel p-6 rounded-[20px] h-48 bg-bah-panel-soft" />
        <div className="bah-panel p-6 rounded-[20px] h-48 bg-bah-panel-soft" />
      </div>
    </div>
  );
}
