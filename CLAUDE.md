1. PROJECT IDENTITY
   Project name: My Game Dex

My Game Dex is a global social network and collection management platform for physical video game collectors.

The platform combines:

Social networking.
Physical video game collection management.
Game database and cataloging.
Collector profiles.
Game reviews and ratings.
Community discussions.
Virtual collection shelves.
The main vision is to become the digital home of physical video game collectors.

Brand tagline: "Your collection. Your gaming identity."

Target audience: Global gaming and physical video game collecting community.

Primary language: English.

2. CORE PRODUCT PRINCIPLES
   Always prioritize these principles:

Social-first experience.
Physical game collecting as the main focus.
Beautiful visual presentation of collections.
Accurate game and physical release information.
Strong community features.
Excellent user experience.
Scalable and maintainable architecture.
Responsive design.
Security and user privacy.
My Game Dex is not just a game tracking application.

The user's collection is an important part of their digital identity.

3. TECHNOLOGY STACK
   Use:

Next.js
React
TypeScript
Next.js App Router
Tailwind CSS
shadcn/ui
Lucide React
Supabase
PostgreSQL
Supabase Authentication
Supabase Storage
Vercel
GitHub
Use compatible stable dependency versions.

Do not introduce additional dependencies without a good reason.

Prefer server components by default. Use client components only when interactivity or browser-side functionality requires them.

4. DESIGN SYSTEM
   Visual identity
   My Game Dex should feel like a premium modern technology product with subtle retro gaming influences.

Design direction: Modern + Premium + Subtle Retro Gaming.

Default appearance: Dark Mode.

Support Light Mode as well.

Colors
Background: #101116
Surface: #191B24
Primary: #8B5CF6
Secondary: #38BDF8
Primary text: #F5F5F7
Secondary text: #9CA3AF
Design rules
Use consistent spacing.
Use rounded corners between 10px and 14px.
Prefer subtle borders over heavy shadows.
Avoid excessive gradients.
Avoid unnecessary neon effects.
Use consistent typography.
Keep layouts clean and readable.
Use game cover artwork as an important visual element.
Use consistent component styles.
Provide hover, focus, active, disabled and loading states.
Never introduce random colors or inconsistent styling.

Use centralized design tokens wherever possible.

5. APPLICATION LAYOUT
   Desktop:

Fixed left sidebar.
Main content area.
Optional right contextual sidebar.
Tablet:

Compact navigation.
Responsive content layout.
Mobile:

Bottom navigation.
Single-column content.
Optimized virtual shelves.
Suggested navigation:

Home
Explore
My Collection
Community
Notifications
Messages
My Profile
Settings
Global search should be accessible from the main application header.

6. MAIN PRODUCT FEATURES
   Social Feed
   Support:

General Posts.
New Pickup.
Collection Showcase.
Game Reviews.
Discussions.
Achievements.
Posts should support:

Text.
Images.
Related games.
Likes.
Comments.
Bookmarks.
Sharing.
Reporting.
Collections
Users should be able to:

Add physical games.
Organize games into shelves.
Create custom shelves.
Reorder shelves.
Reorder games.
Upload real collection photographs.
Track physical condition.
Track completeness.
Track purchase price and date.
Create a Wantlist.
Set collection visibility.
Virtual shelves are the default collection presentation.

Profiles
Profiles should include:

Avatar.
Cover image.
Username.
Biography.
Followers.
Following.
Collection statistics.
Favorite games.
Public shelves.
Reviews.
Activity.
Game Database
Maintain a centralized catalog.

Always distinguish:

Game — underlying video game.
Release — specific platform and physical edition.
Collection Item — individual physical copy owned by a user.
Never merge these three concepts into one database entity.

Support different platforms and regional releases.

Community
Support:

Following users.
Discovering collectors.
Reviews.
Discussions.
Comments.
Notifications.
Private messaging. 7. DATABASE AND BACKEND RULES
Use Supabase and PostgreSQL.

Maintain clear separation between:

Database schema.
Data access.
Business logic.
UI components.
Use strict TypeScript types for database operations.

Use foreign keys, constraints and appropriate indexes.

Use Supabase Row Level Security (RLS) for all user-related private data.

Never trust client-side authorization.

Never expose Supabase service-role keys or other secrets in frontend code.

Keep environment variables in .env.local.

Maintain .env.example with placeholder values only.

Never commit real credentials.

8. GAME DATA RULES
   Do not hardcode a large game catalog.

Use a modular architecture for external game metadata providers.

Check API terms, rate limits, attribution requirements and commercial licensing before integration.

Do not assume external cover art or screenshots are free for commercial use.

Support manual catalog corrections through controlled administrative functionality.

9. CODE QUALITY RULES
   Always:

Use strict TypeScript.
Prefer reusable components.
Keep components focused and reasonably small.
Use descriptive naming.
Avoid unnecessary code duplication.
Separate business logic from presentation.
Validate user input.
Handle errors explicitly.
Add loading states.
Add empty states.
Add appropriate error states.
Use accessible semantic HTML.
Keep imports organized.
Avoid:

Giant components.
any types unless absolutely necessary.
Hardcoded production data.
Fake functionality.
Unnecessary dependencies.
Duplicated business logic.
Unnecessary client components.
All buttons, links and interactive elements must have real functionality.

Never present mock functionality as a completed backend feature.

10. RESPONSIVE DESIGN
    Use these breakpoints:

Mobile: up to 767px.
Tablet: 768px–1023px.
Desktop: 1024px and above.
Wide desktop: 1440px and above.
Always test layouts across screen sizes.

Pay special attention to:

Game cover grids.
Virtual shelves.
Social feed cards.
Profile layouts.
Navigation.
Image uploads. 11. SECURITY AND PRIVACY
Security is a core requirement.

Always:

Validate input on the server.
Check user permissions.
Apply RLS policies.
Protect private collections.
Restrict unauthorized data access.
Validate uploaded files.
Apply image upload size limits.
Protect sensitive endpoints against abuse.
Implement reporting and blocking functionality.
Never expose private user information through public profiles or API responses.

12. DEVELOPMENT WORKFLOW
    Work incrementally.

Before implementing a feature:

Inspect the existing codebase.
Understand the current architecture.
Identify affected components and database entities.
Explain the implementation approach when the change is significant.
Implement the feature.
Check TypeScript errors.
Run relevant tests.
Verify responsive behavior.
Summarize the changes.
Do not rewrite existing working code without a clear reason.

Do not make unrelated changes while implementing a feature.

Do not delete existing functionality without explicit justification.

Keep README.md and project documentation updated.

13. MVP PRIORITIES
    Prioritize development in this order:

Priority 1 — Foundation
Project setup.
Design system.
Responsive application shell.
Authentication.
User profiles.
Priority 2 — Collections
Game database.
Platforms.
Releases.
Collection items.
Virtual shelves.
Wantlist.
Priority 3 — Social
Home feed.
Posts.
Likes.
Comments.
Following.
Reviews.
Priority 4 — Discovery
Explore.
Global search.
Collector recommendations.
Trending games.
Priority 5 — Advanced Features
Notifications.
Messaging.
Advanced statistics.
Collection valuation.
Marketplace.
Do not prioritize marketplace functionality before the core social and collection experience is working.

14. IMPORTANT PROJECT RULES
    English is the default language for the application UI.
    Keep the architecture ready for localization.
    Use a consistent visual identity.
    Prioritize user experience over unnecessary complexity.
    Never compromise database security for development convenience.
    Do not introduce features outside the project vision without discussing their impact.
    Do not assume that a feature is complete just because its UI exists.
    Keep the application production-minded from the beginning.
15. COMMUNICATION
    When working on My Game Dex:

Act as a senior full-stack engineer.
Think like a product designer.
Explain important architectural decisions.
Identify potential technical problems early.
Suggest improvements when appropriate.
Ask before making major changes to the architecture.
Prefer practical solutions over unnecessary complexity.
The ultimate goal is to build My Game Dex into a scalable global social network for physical video game collectors.
